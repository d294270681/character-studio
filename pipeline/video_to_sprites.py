"""Extract, align and pack an actual MiniMax H3 video into Godot sprite frames."""

import argparse
import json
import math
import re
import sys
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studio_data import COMFY_OUTPUT, DATA, EXPORT_DIR, GODOT_PROJECT

PROJECT = GODOT_PROJECT or EXPORT_DIR
PIPELINE = DATA / "h3"
ASSETS = PROJECT / "assets/characters"
CELL_SIZE = (384, 512)


def read_sources(history_path):
    history = json.loads(history_path.read_text(encoding="utf-8"))
    image_results = history["outputs"]["16"]["images"]
    files = [COMFY_OUTPUT / item["subfolder"] / item["filename"] for item in image_results]
    images = [Image.open(path).convert("RGB") for path in files]
    videos = history["outputs"]["15"]
    video_results = next(value for value in videos.values() if isinstance(value, list))
    video_path = COMFY_OUTPUT / video_results[0]["subfolder"] / video_results[0]["filename"]
    with av.open(str(video_path)) as container:
        fps = float(container.streams.video[0].average_rate)
    return images, fps, video_path


def background_profile(image):
    """Conservative neutral-background thresholds learned from a clean first frame.

    Bright hair and clothing raise the local threshold, so a grey shadow is not
    confused with a light costume merely because both have low saturation.
    """
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    white = (border.min(axis=1) >= 228) & (np.ptp(border, axis=1) <= 24)
    if white.mean() < 0.85:
        raise ValueError("白底抑影需要四周为白色的画面；请先使用白底视频，或关闭白底净化/抑制灰影。")
    character, bounds, _ = extract_character(image)
    inside = ndimage.binary_erosion(np.asarray(character)[:, :, 3] > 0, iterations=2)
    top, bottom = bounds[1], bounds[3]
    thresholds = []
    for band in range(24):
        lo = top + int((bottom - top) * band / 24)
        hi = top + int((bottom - top) * (band + 1) / 24)
        values = rgb[lo:hi].max(axis=2)[inside[lo:hi]]
        thresholds.append(float(np.percentile(values, 99)) + 22 if len(values) > 5 else 228)
    return np.clip(thresholds, 65, 228)


def _border_background(allowed):
    border = np.zeros(allowed.shape, dtype=bool)
    border[0] = allowed[0]
    border[-1] = allowed[-1]
    border[:, 0] = allowed[:, 0]
    border[:, -1] = allowed[:, -1]
    return ndimage.binary_propagation(border, mask=allowed)


def extract_character(image, profile=None):
    rgb = np.asarray(image.convert("RGB"))
    nearly_white = (rgb.min(axis=2) >= 228) & (rgb.max(axis=2) - rgb.min(axis=2) <= 24)
    background = _border_background(nearly_white)
    foreground = ~background
    labels, count = ndimage.label(foreground)
    if count == 0:
        raise ValueError("A generated frame has no visible character.")
    areas = np.bincount(labels.ravel())
    areas[0] = 0
    primary_label = int(areas.argmax())
    primary = labels == primary_label
    distance = ndimage.distance_transform_edt(~primary)
    nearest = ndimage.minimum(distance, labels=labels, index=np.arange(len(areas)))
    keep = (areas >= 2) & (nearest <= 4)
    keep[primary_label] = True
    keep[0] = False
    foreground = keep[labels]
    ys, xs = np.nonzero(foreground)
    left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)
    if profile is not None:
        positions = np.clip((np.arange(image.height) - top) / max(1, bottom - top) * len(profile) - 0.5, 0, len(profile) - 1)
        thresholds = np.interp(positions, np.arange(len(profile)), profile)
        neutral = rgb.max(axis=2) - rgb.min(axis=2) <= 12
        removable = nearly_white | (neutral & (rgb.min(axis=2) >= thresholds[:, None]))
        foreground &= ~_border_background(removable)
        ys, xs = np.nonzero(foreground)
        if not len(xs):
            raise ValueError("白底处理后没有可见人物，请关闭抑制灰影后重试。")
        left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)
    band_top = top + round((bottom - top) * 0.20)
    band_bottom = top + round((bottom - top) * 0.45)
    torso_x = np.nonzero(foreground[band_top:band_bottom])[1]
    anchor_x = float(np.median(torso_x)) if len(torso_x) else (left + right) / 2
    rgba = np.dstack((rgb, foreground.astype(np.uint8) * 255))
    return Image.fromarray(rgba), (left, top, right, bottom), anchor_x


def align_frames(characters, bounds, anchors, indices, pixel_size, margin=24, alignment="feet"):
    width, height = CELL_SIZE
    if alignment not in ("source", "feet"):
        raise ValueError("Unknown frame alignment.")
    if alignment == "source":
        # One transform for the entire interval preserves both lateral motion
        # and vertical bobbing. Per-frame foot alignment removes that motion.
        union = (min(bounds[i][0] for i in indices), min(bounds[i][1] for i in indices),
                 max(bounds[i][2] for i in indices), max(bounds[i][3] for i in indices))
        scale = min((width - margin * 2) / (union[2] - union[0]),
                    (height - margin * 2) / (union[3] - union[1]), 1.0)
        target_size = (max(1, round((union[2] - union[0]) * scale)), max(1, round((union[3] - union[1]) * scale)))
        offset = ((width - target_size[0]) // 2, height - margin - target_size[1])
        cells = []
        for index in indices:
            cropped = characters[index].crop(union)
            resized = cropped.resize(target_size, Image.Resampling.LANCZOS if pixel_size == 1 else Image.Resampling.NEAREST)
            cell = Image.new("RGBA", CELL_SIZE, (0, 0, 0, 0))
            cell.alpha_composite(resized, offset)
            if pixel_size > 1:
                cell = cell.resize((width // pixel_size, height // pixel_size), Image.Resampling.NEAREST).resize(CELL_SIZE, Image.Resampling.NEAREST)
            cells.append(cell)
        return cells
    tallest = max(bounds[index][3] - bounds[index][1] for index in indices)
    widest_half = max(max(anchors[index] - bounds[index][0], bounds[index][2] - anchors[index]) for index in indices)
    scale = min((height - margin * 2) / tallest, (width / 2 - margin) / widest_half)
    cells = []
    for index in indices:
        left, top, right, bottom = bounds[index]
        cropped = characters[index].crop((left, top, right, bottom))
        resized = cropped.resize((max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))), Image.Resampling.LANCZOS if pixel_size == 1 else Image.Resampling.NEAREST)
        offset_x = round(width / 2 - (anchors[index] - left) * scale)
        offset_y = height - margin - resized.height
        cell = Image.new("RGBA", CELL_SIZE, (0, 0, 0, 0))
        cell.alpha_composite(resized, (offset_x, offset_y))
        if pixel_size > 1:
            cell = cell.resize((width // pixel_size, height // pixel_size), Image.Resampling.NEAREST).resize(CELL_SIZE, Image.Resampling.NEAREST)
        cells.append(cell)
    return cells


def white_background(image):
    white = Image.new("RGBA", image.size, "white")
    white.alpha_composite(image)
    return white.convert("RGB")


def select_cycle(cells):
    features = []
    for cell in cells:
        small = white_background(cell).resize((48, 64), Image.Resampling.BILINEAR)
        features.append(np.asarray(small, dtype=np.float32)[16:] / 255.0)
    features = np.stack(features)
    first = 12
    last = len(cells) - 8
    scores = []
    for period in range(14, min(43, last - first)):
        diffs = np.abs(features[first:last - period] - features[first + period:last]).mean(axis=(1, 2, 3))
        score = float(np.median(diffs)) * (1 + 0.0007 * (period - 24) ** 2)
        scores.append((score, period))
    _, period = min(scores)
    choices = []
    for start in range(first, last - period):
        boundary_error = float(np.abs(features[start] - features[start + period]).mean())
        movement = float(np.abs(np.diff(features[start:start + period], axis=0)).mean())
        choices.append((boundary_error - 0.2 * movement, start))
    _, start = min(choices)
    return start, start + period, [{"period": period_value, "score": score} for score, period_value in sorted(scores)]


def save_contact_sheet(images, fps, target):
    sampled = np.linspace(0, len(images) - 1, 24).round().astype(int)
    tile_width, tile_height = 128, 208
    board = Image.new("RGB", (tile_width * 6, tile_height * 4), "white")
    draw = ImageDraw.Draw(board)
    for slot, index in enumerate(sampled):
        thumb = images[index].copy()
        thumb.thumbnail((128, 188), Image.Resampling.NEAREST)
        x, y = (slot % 6) * tile_width, (slot // 6) * tile_height
        board.paste(thumb, (x + (tile_width - thumb.width) // 2, y))
        draw.text((x + 6, y + 190), f"{index:03d}  {index / fps:.2f}s", fill="#28483d")
    board.save(target)


def save_sprite_frames(target, texture_name, count, columns, fps, texture_resource=None, animation_name="walk_left_front"):
    width, height = CELL_SIZE
    texture_resource = texture_resource or f"res://assets/characters/{texture_name}"
    lines = ['[gd_resource type="SpriteFrames" format=3]', '', f'[ext_resource type="Texture2D" path={json.dumps(texture_resource)} id="1_sheet"]', '']
    for index in range(count):
        lines.extend([f'[sub_resource type="AtlasTexture" id="AtlasTexture_{index + 1}"]', 'atlas = ExtResource("1_sheet")', f'region = Rect2({index % columns * width}, {index // columns * height}, {width}, {height})', ''])
    frames = ', '.join('{"duration": 1.0, "texture": SubResource("AtlasTexture_%d")}' % (index + 1) for index in range(count))
    lines.extend(['[resource]', 'animations = [{', f'"frames": [{frames}],', '"loop": true,', f'"name": &{json.dumps(animation_name, ensure_ascii=False)},', f'"speed": {fps:.6f}', '}]', ''])
    target.write_text('\n'.join(lines), encoding="utf-8")


def save_preview_scene(name, label, resource_path, animation_name="walk_left_front", in_place=False, smooth=False, project=None):
    """Write a self-contained scene with no dependency on a private game script."""
    project = Path(project or PROJECT)
    target = project / "scenes" / (name + "_preview.tscn")
    target.parent.mkdir(parents=True, exist_ok=True)
    frames_resource = "res://" + resource_path.relative_to(project).as_posix()
    lines = ['[gd_scene format=3]', '',
             f'[ext_resource type="SpriteFrames" path={json.dumps(frames_resource)} id="1_frames"]', '',
             '[node name="CharacterPreview" type="Node2D"]', '',
             '[node name="AnimatedSprite2D" type="AnimatedSprite2D" parent="."]',
             f'texture_filter = {2 if smooth else 1}', 'position = Vector2(640, 400)',
             'sprite_frames = ExtResource("1_frames")',
             f'animation = &{json.dumps(animation_name, ensure_ascii=False)}',
             f'autoplay = {json.dumps(animation_name, ensure_ascii=False)}', '']
    target.write_text('\n'.join(lines), encoding="utf-8")
    if GODOT_PROJECT is None and not (project / "project.godot").exists():
        scene_resource = "res://" + target.relative_to(project).as_posix()
        (project / "project.godot").write_text(
            'config_version=5\n\n[application]\nconfig/name="Character Studio Export"\n'
            + 'run/main_scene=' + json.dumps(scene_resource) + '\n\n[display]\n'
            + 'window/size/viewport_width=1280\nwindow/size/viewport_height=800\n'
            + '\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n', encoding="utf-8")
    return target


def latest_successful_history():
    for path in sorted((PIPELINE / "runs").glob("*/history.json"), reverse=True):
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("status", {}).get("status_str") == "success" and record.get("outputs", {}).get("16", {}).get("images"):
            return path
    raise RuntimeError("No successful H3 video run was found. Generate a video or pass --history.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", type=Path)
    parser.add_argument("--start", type=int)
    parser.add_argument("--end", type=int)
    parser.add_argument("--frames", type=int, default=16)
    parser.add_argument("--pixel-size", type=int, default=2)
    parser.add_argument("--name", default="character_walk_left_front")
    parser.add_argument("--character-label", default="Character")
    parser.add_argument("--preview-scene", action="store_true")
    parser.add_argument("--result-dir", type=Path, help="Save inspection images and conversion metadata outside the source run")
    parser.add_argument("--inspect-only", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,127}", args.name):
        parser.error("Sprite name must be a lowercase filename-safe identifier.")
    if args.frames < 2 or args.pixel_size < 1 or CELL_SIZE[0] % args.pixel_size or CELL_SIZE[1] % args.pixel_size:
        parser.error("Use at least two frames and a positive pixel grid dividing the cell dimensions.")
    history_path = args.history or latest_successful_history()
    images, video_fps, video_path = read_sources(history_path)
    run_dir = args.result_dir or history_path.parent
    run_dir.mkdir(parents=True, exist_ok=True)
    save_contact_sheet(images, video_fps, run_dir / "video_contact_sheet.png")
    raw_preview = []
    for image in images[::2]:
        preview = image.resize((256, 384), Image.Resampling.NEAREST)
        raw_preview.append(preview.quantize(colors=128, dither=Image.Dither.NONE))
    raw_preview[0].save(run_dir / "video_preview.gif", save_all=True, append_images=raw_preview[1:], loop=0, duration=round(2000 / video_fps), disposal=2)
    print(f"Video: {video_path}; {len(images)} frames at {video_fps:.2f} FPS")
    print(f"Contact sheet: {run_dir / 'video_contact_sheet.png'}")
    if args.inspect_only:
        return
    separated = [extract_character(image) for image in images]
    characters, bounds, anchors = zip(*separated)
    all_indices = list(range(len(images)))
    normalized = align_frames(characters, bounds, anchors, all_indices, args.pixel_size)
    start, end, cycle_scores = select_cycle(normalized)
    if args.start is not None:
        start = args.start
    if args.end is not None:
        end = args.end
    if not 0 <= start < end < len(images):
        raise ValueError(f"Invalid cycle bounds: [{start}, {end}) for {len(images)} video frames.")
    if args.frames > end - start:
        raise ValueError("The requested sprite count exceeds the source cycle frame count.")
    selected = np.linspace(start, end, args.frames, endpoint=False).round().astype(int).tolist()
    cells = align_frames(characters, bounds, anchors, selected, args.pixel_size)
    columns = 4
    rows = math.ceil(len(cells) / columns)
    sheet = Image.new("RGBA", (CELL_SIZE[0] * columns, CELL_SIZE[1] * rows), (0, 0, 0, 0))
    for slot, cell in enumerate(cells):
        sheet.alpha_composite(cell, ((slot % columns) * CELL_SIZE[0], (slot // columns) * CELL_SIZE[1]))
    name = args.name
    ASSETS.mkdir(parents=True, exist_ok=True)
    sheet_path = ASSETS / (name + "_rgba.png")
    sheet.save(sheet_path)
    white_path = ASSETS / (name + "_white.png")
    white_background(sheet).save(white_path)
    animation_fps = video_fps * len(cells) / (end - start)
    resource_path = ASSETS / (name + ".tres")
    save_sprite_frames(resource_path, sheet_path.name, len(cells), columns, animation_fps)
    gif_frames = [white_background(cell).quantize(colors=128, dither=Image.Dither.NONE) for cell in cells]
    gif_path = run_dir / "walk_cycle.gif"
    gif_frames[0].save(gif_path, save_all=True, append_images=gif_frames[1:], loop=0, duration=round(1000 / animation_fps), disposal=2)
    metadata = {"model": "MiniMax H3 FL2VA + Turbo V4", "source_video": str(video_path), "video_fps": video_fps, "video_frames": len(images), "cycle_start": start, "cycle_end": end, "selected_frames": selected, "animation_fps": animation_fps, "cell_size": CELL_SIZE, "grid": [columns, rows], "pixel_size": args.pixel_size, "sprite_sheet": str(sheet_path), "white_preview": str(white_path), "resource": str(resource_path), "gif": str(gif_path), "cycle_candidates": cycle_scores}
    if args.preview_scene:
        scene = save_preview_scene(name, args.character_label, resource_path)
        metadata["preview_scene"] = str(scene)
        metadata["preview_scene_resource"] = "res://" + scene.relative_to(PROJECT).as_posix()
    (run_dir / "sprite_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
