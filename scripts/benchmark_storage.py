import json
from pathlib import Path
from tempfile import TemporaryDirectory
from timeit import timeit
from earth_globe_demo.models import Point
from earth_globe_demo.storage import PointRepository

with TemporaryDirectory() as folder:
    path = Path(folder) / 'points.json'
    path.write_text(json.dumps([dict(id=str(i), label=f'Point {i}', latitude=0, longitude=0,
        color='#ff8d57', created_at='2026-09-09T00:00:00Z') for i in range(5000)]))
    repository = PointRepository(path)
    repository.list_points()
    def previous_read():
        return [Point.model_validate(item) for item in json.loads(path.read_text())]
    before = timeit(previous_read, number=100) / 100 * 1000
    after = timeit(repository.list_points, number=100) / 100 * 1000
    print(f'5,000 points, 100 warm reads: old parsing {before:.3f} ms/read; cached + file lock {after:.3f} ms/read; {before/after:.1f}x faster repository reads. Not an end-to-end API benchmark.')
