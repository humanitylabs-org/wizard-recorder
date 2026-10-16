"""Small offline source-gate checks; no service, browser or provider calls."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('lineage', Path(__file__).parents[1] / 'tools/check-deployment-lineage.py')
assert spec and spec.loader
lineage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lineage)


class SourcePreservation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.git('init', '-q', str(self.repo), at=self.root)
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Source test')
        (self.repo / 'app').mkdir()
        (self.repo / 'app/app.js').write_text('baseline\n')
        self.commit('base')
        self.base = self.git('rev-parse', 'HEAD')
        (self.repo / 'app/app.js').write_text('approved live fix\n')
        self.commit('live fix')
        self.live_sha = self.git('rev-parse', 'HEAD')
        self.live = self.root / 'live'
        self.git('worktree', 'add', '--detach', str(self.live), self.live_sha)
        (self.repo / 'app/new.js').write_text('candidate feature\n')
        self.commit('new feature')

    def git(self, *args, at=None):
        return subprocess.check_output(['git', '-C', str(at or self.repo), *args], stderr=subprocess.DEVNULL, text=True).strip()

    def commit(self, msg):
        self.git('add', '.'); self.git('commit', '-qm', msg)

    def check(self, base=None):
        return lineage.check(self.live / 'app', self.repo / 'app', base or self.base)

    def test_preserves_deployed_fix_and_manifest(self):
        r = self.check(); self.assertTrue(r['ok']); self.assertEqual(r['changed_files'], ['new.js'])
        self.assertEqual(r['deployed_revision'], self.live_sha)

    def test_stale_candidate_missing_live_fix_blocks(self):
        self.git('checkout', '--detach', self.base)
        with self.assertRaisesRegex(ValueError, 'omits deployed'):
            self.check()

    def test_approved_base_must_be_integrated(self):
        self.git('checkout', '-b', 'other', self.base)
        (self.repo / 'app/approved.js').write_text('approved other fix')
        self.commit('other fix'); other = self.git('rev-parse', 'HEAD')
        self.git('checkout', '--detach', self.live_sha)
        with self.assertRaisesRegex(ValueError, 'approved base'):
            self.check(other)

    def test_dirty_live_blocks(self):
        (self.live / 'app/app.js').write_text('live-only uncommitted fix')
        with self.assertRaisesRegex(ValueError, 'uncommitted'):
            self.check()

    def test_dirty_candidate_blocks(self):
        (self.repo / 'app/app.js').write_text('not tested or committed')
        with self.assertRaisesRegex(ValueError, 'uncommitted'):
            self.check()

    def test_untracked_source_blocks(self):
        (self.live / 'app/missed.css').write_text('unadopted live fix')
        with self.assertRaisesRegex(ValueError, 'untracked'):
            self.check()

    def test_projection_switch_blocks(self):
        with self.assertRaisesRegex(ValueError, 'projection differs'):
            lineage.check(self.live, self.repo / 'app', self.base)

    def test_symlink_source_blocks(self):
        (self.repo / 'app/external.js').symlink_to(self.live / 'app/app.js')
        self.commit('external source')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.check()


if __name__ == '__main__':
    unittest.main()
