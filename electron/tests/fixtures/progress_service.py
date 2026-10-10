"""Use the real service API and worker orchestration with a controlled worker."""
import sys
from pathlib import Path

STUDIO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(STUDIO))
import studio_service as svc

OriginalService = svc.StudioService


class ControlledService(OriginalService):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, backend_python=sys.executable,
                         backend_script=Path(__file__).with_name("progress_backend.py"), **kwargs)


svc.StudioService = ControlledService
svc.main()
