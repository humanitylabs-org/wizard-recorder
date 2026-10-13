"""Static view build contract: verify the editable view entrypoint exists."""
from pathlib import Path
root = Path(__file__).resolve().parent.parent
assert (root / 'web/index.html').is_file()
print('Meeting Recorder static view ready: web/')
