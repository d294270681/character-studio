const PATHS = {
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  check: ['M20 6 9 17l-5-5'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  play: ['M7 4.5v15l13-7.5z'],
  pause: ['M9 5v14', 'M15 5v14'],
  image: ['M4 4h16v16H4z', 'M8.5 10.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2', 'M4 16.5 9 12l4.5 4L17 12.5l3 3'],
  wand: ['M5 19 16 8', 'M14 4.5 15 6.5', 'M18.5 9 20.5 10', 'M19 4l1 1', 'M13 15l4 4'],
  film: ['M3.5 5h17v14h-17z', 'M8 5v14', 'M16 5v14', 'M3.5 9.5h4.5', 'M3.5 14.5h4.5', 'M16 9.5h4.5', 'M16 14.5h4.5'],
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  layers: ['M12 3 3 8l9 5 9-5z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  folder: ['M3.5 6.5h6l2 2.5h9v10h-17z'],
  folderOpen: ['M3.5 6.5h6l2 2.5h9', 'M3.5 9h17l-2 10h-15z'],
  save: ['M5 4h11l3 3v13H5z', 'M9 4v6h6V4', 'M8 20v-6h8v6'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18', 'M9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.5-1.2 1-1.2 1.9', 'M12 17h.01'],
  refresh: ['M20 11a8 8 0 1 0-2.4 6.4', 'M20 4.5V11h-6.2'],
  chevronDown: ['M6 9.5 12 15.5l6-6'],
  chevronRight: ['M9.5 6 15.5 12l-6 6'],
  arrowRight: ['M4 12h15', 'M13 6l6 6-6 6'],
  robot: ['M6 9h12v9H6z', 'M12 4v5', 'M9.5 13h.01', 'M14.5 13h.01', 'M4 12.5v3', 'M20 12.5v3', 'M10 18v2', 'M14 18v2'],
  terminal: ['M4 5h16v14H4z', 'M7.5 10l2.5 2.5-2.5 2.5', 'M12.5 15H17'],
  copy: ['M8 8h11v12H8z', 'M5 16V4h11'],
  download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19.5h14'],
  alert: ['M12 4 2.5 20h19z', 'M12 10v4.5', 'M12 17.5h.01'],
  compare: ['M12 3v18', 'M4 7h5v10H4z', 'M15 7h5v10h-5z'],
  dice: ['M4 4h16v16H4z', 'M8.5 8.5h.01', 'M15.5 8.5h.01', 'M8.5 15.5h.01', 'M15.5 15.5h.01', 'M12 12h.01'],
  cpu: ['M8 8h8v8H8z', 'M5 5h14v14H5z', 'M9 2v3', 'M15 2v3', 'M9 19v3', 'M15 19v3', 'M2 9h3', 'M2 15h3', 'M19 9h3', 'M19 15h3'],
  users: ['M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11', 'M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5', 'M16 5.2a3.2 3.2 0 0 1 0 6.2', 'M17.5 14.8c2.1.6 3.5 2.3 3.5 4.7'],
  palette: ['M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-.9 2-1.8 0-1.6-1.6-1.7-1.6-3.1 0-1.1.9-1.9 2.1-1.9h1.3a4.7 4.7 0 0 0 4.7-4.7C20.5 6.1 16.7 3.5 12 3.5', 'M7.5 10h.01', 'M11 7.5h.01', 'M15 9h.01'],
  sparkle: ['M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 17.7 10.3 12.4 5 10.7 10.3 9z', 'M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'],
  eye: ['M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6'],
  scissors: ['M6.5 6.5 17 17', 'M17 7 6.5 17.5', 'M6.5 8.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4', 'M6.5 19.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18', 'M12 7.5V12l3 2'],
};

export default function Icon({ name, size = 16, className = '', strokeWidth = 1.7 }) {
  const paths = PATHS[name];
  if (!paths) return null;
  const filled = name === 'play' || name === 'pause';
  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map(path => <path key={path} d={path} />)}
    </svg>
  );
}
