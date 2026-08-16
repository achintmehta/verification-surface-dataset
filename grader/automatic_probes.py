#!/usr/bin/env python3
"""
automatic_probes.py — the AUTOMATIC (machine) grader for coding-agent eval runs.

Grades the artifact (the generated app), not the run transcript, using only
machine-observable signals. It performs NO human/visual scoring: it emits a
blank scorecard for a human to fill later, and the human scores are folded in
downstream by merge_results.py. This script's output is machine-only.

What it does, per run
---------------------
  - stages a fresh copy of app/ (never grades in place); optional npm install
  - boots the backend (one missing-directory retry) and records boot_ok / class
  - runs the task's adversarial probe suite (functional_score / functional_max)
  - static spec-fidelity checks (mandated stack present, forbidden subs absent)
  - static defect scan (syntax errors, undeclared / broken-relative imports)
  - counts tool usage from the run's commands.json
  - with --emit-scorecards, writes a blank visual-scores.json for the human

Output schema (one JSON row appended per run to automatic_probes_results.jsonl)
------------------------------------------------------------------------------
  run, task, model, condition, run_status
  boot_ok (bool), boot_failure_class (only on failure), entry, port
  probes {name: {ok, weight, evidence}}
  functional_score, functional_max, functional_pct (0-100; 0 on boot failure,
    None for rubric-only generic specs)
  fidelity {9 booleans}, fidelity_score (0-1 in eighths)
  static_defects {syntax_errors[], undeclared_imports[], broken_relative_imports[]}
  tool_uptake {tool: count}, notes[]
  NOTE: NO visual_pct / visual_items / visual_graded_by / overall_pct — human
  scoring lives in the cards and is applied by merge_results.py.

Usage:
  python3 automatic_probes.py <run_dir> [<run_dir> ...]
                    [--task auto|message-board|kanban-board|seat-booking]
                    [--out automatic_probes_results.jsonl] [--csv ...]
                    [--emit-scorecards] [--install] [--keep-work] [--timeout-boot 30]

  run_dir may be the run dir (containing app/) or the app dir itself.
  Globs are fine: python3 automatic_probes.py runs-root/*/runs/*

Exit code 0 always (per-run failures are data, not errors).
"""

import argparse, csv, glob, json, os, re, shutil, signal, socket, subprocess, sys, threading, time
import http.client
from pathlib import Path

# ----------------------------------------------------------------------------
# small utilities
# ----------------------------------------------------------------------------

def log(*a):
    print('[grader]', *a, file=sys.stderr, flush=True)

def free_localhost_ports_of(pid):
    """Return listening TCP ports owned by pid (via ss)."""
    try:
        out = subprocess.run(['ss', '-ltnp'], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    ports = []
    for line in out.splitlines():
        if f'pid={pid}' in line or f'pid={pid},' in line:
            m = re.search(r':(\d+)\s', line)
            if m:
                ports.append(int(m.group(1)))
    return sorted(set(ports))

def http_json(method, port, path, body=None, timeout=8, headers=None):
    """One-shot HTTP request. Returns (status, parsed-or-text, raw_headers)."""
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    try:
        hdrs = {'Content-Type': 'application/json'}
        if headers: hdrs.update(headers)
        payload = json.dumps(body) if body is not None else None
        conn.request(method, path, body=payload, headers=hdrs)
        r = conn.getresponse()
        raw = r.read(200_000).decode('utf-8', 'replace')
        try:
            data = json.loads(raw) if raw.strip() else None
        except json.JSONDecodeError:
            data = raw
        return r.status, data, dict(r.getheaders())
    finally:
        conn.close()

class SSEClient:
    """SSE listener backed by curl -N (correct chunked decoding, zero deps).

    Mirrors a tiny thread-like API: start(), stop(), join(), .events,
    .headers, .status, .data_blobs().
    """
    _seq = 0

    def __init__(self, port, path):
        self.port, self.path = port, path
        SSEClient._seq += 1
        base = Path('/tmp') / f'grader-sse-{os.getpid()}-{SSEClient._seq}'
        self.body_f, self.hdr_f = base.with_suffix('.body'), base.with_suffix('.hdr')
        self.proc = None
        self.error = None

    def start(self):
        for f in (self.body_f, self.hdr_f):
            f.write_text('')
        self.proc = subprocess.Popen(
            ['curl', '-sN', '--max-time', '600',
             '-D', str(self.hdr_f), '-o', str(self.body_f),
             '-H', 'Accept: text/event-stream',
             f'http://127.0.0.1:{self.port}{self.path}'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    @property
    def status(self):
        try:
            line = self.hdr_f.read_text().splitlines()[0]
            return int(line.split()[1])
        except Exception:
            return None

    @property
    def headers(self):
        h = {}
        try:
            for line in self.hdr_f.read_text().splitlines()[1:]:
                if ':' in line:
                    k, v = line.split(':', 1)
                    h[k.strip().lower()] = v.strip()
        except Exception:
            pass
        return h

    @property
    def events(self):
        try:
            raw = self.body_f.read_text(errors='replace')
        except Exception:
            return []
        return [b.strip() for b in raw.split('\n\n') if b.strip()]

    def data_blobs(self):
        out = []
        for ev in self.events:
            datas = [l[5:].strip() for l in ev.splitlines() if l.startswith('data:')]
            out.append('\n'.join(datas) if datas else ev)
        return out

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()

    def join(self, timeout=None):
        if self.proc:
            try:
                self.proc.wait(timeout=timeout or 5)
            except subprocess.TimeoutExpired:
                pass

def wait_for(predicate, timeout, interval=0.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = predicate()
        if v:
            return v
        time.sleep(interval)
    return None

# ----------------------------------------------------------------------------
# app lifecycle: stage, boot, restart
# ----------------------------------------------------------------------------

SRC_EXT = ('.js', '.mjs', '.cjs', '.ts', '.json', '.html', '.css')
SKIP_DIRS = {'node_modules', '.git', 'data', 'db', 'pgdata', 'board-data',
             '.pglite', 'pglite-data', 'test-results', 'playwright-report', 'dist'}

class App:
    def __init__(self, app_dir, work_root, install=False, boot_timeout=30):
        self.src = Path(app_dir).resolve()
        self.work = Path(work_root)
        self.install = install
        self.boot_timeout = boot_timeout
        self.proc = None
        self.port = None
        self.entry = None
        self.notes = []

    # -- staging ---------------------------------------------------------
    def stage(self):
        if self.work.exists():
            shutil.rmtree(self.work)
        self.work.mkdir(parents=True)
        for root, dirs, files in os.walk(self.src):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            rel = Path(root).relative_to(self.src)
            for f in files:
                if f.endswith(SRC_EXT) and not f.startswith('cmd_out_'):
                    dst = self.work / rel / f
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(Path(root) / f, dst)
        # link node_modules (root + nested one level: backend/, server/, ...)
        linked = False
        if (self.src / 'node_modules').is_dir():
            os.symlink(self.src / 'node_modules', self.work / 'node_modules')
            linked = True
        for sub in self.work.iterdir():
            if sub.is_dir() and (self.src / sub.name / 'node_modules').is_dir():
                os.symlink(self.src / sub.name / 'node_modules', sub / 'node_modules')
                linked = True
        # Provision EVERY manifest dir that still lacks node_modules, not just the
        # work root. The briefing promises "dependencies declared in package.json
        # files are provisioned"; artifacts often keep their manifest nested (e.g.
        # app/package.json with no root manifest), so a root-only install
        # under-provisioned all no_verification/static runs in batch-20260613.
        if self.install:
            installed = False
            for pj in sorted(self.work.rglob('package.json'),
                             key=lambda p: len(p.parts)):
                if 'node_modules' in pj.parts:
                    continue
                d = pj.parent
                if (d / 'node_modules').exists():
                    continue
                rel = str(d.relative_to(self.work))
                self.notes.append(f'npm_install_dir:{rel}')
                subprocess.run(['npm', 'install', '--no-audit', '--no-fund'],
                               cwd=d, capture_output=True, timeout=300)
                installed = True
            if installed:
                self.notes.append('npm_install_run')
        return linked or self.install

    # -- entry detection ---------------------------------------------------
    CANDIDATES = ['server/index.js', 'server.js', 'server/server.js', 'backend/index.js',
                  'backend/server.js', 'src/server/index.js', 'server/index.mjs',
                  'server/main.js', 'backend/src/server.js', 'index.js', 'app.js']

    def _package_roots(self):
        """work root first, then every dir holding a package.json (shallowest first)."""
        roots = [self.work]
        for pj in sorted(self.work.rglob('package.json'), key=lambda p: len(p.parts)):
            if 'node_modules' not in pj.parts and pj.parent != self.work:
                roots.append(pj.parent)
        return roots

    def find_entry(self):
        # candidate list relative to the work root AND every nested package root
        # (artifacts often nest the whole app: app/server/index.js)
        for base in self._package_roots():
            for c in self.CANDIDATES:
                p = base / c
                if p.is_file() and re.search(r'express|createServer', p.read_text(errors='ignore'), re.I):
                    self.entry = str(p.relative_to(self.work))
                    return self.entry
        # package.json hints: "main", or a node entry named in start/dev scripts
        for base in self._package_roots():
            pj = base / 'package.json'
            if not pj.is_file():
                continue
            try:
                meta = json.loads(pj.read_text())
            except Exception:
                continue
            hints = [meta.get('main') or '']
            scripts = meta.get('scripts') or {}
            for k in ('start', 'dev:backend', 'server', 'dev'):
                m = re.search(r'([\w./-]+\.(?:js|mjs|cjs))', scripts.get(k, '') or '')
                if m:
                    hints.append(m.group(1))
            for h in hints:
                if not h:
                    continue
                p = base / h
                if p.is_file() and re.search(r'express|createServer', p.read_text(errors='ignore'), re.I):
                    self.entry = str(p.relative_to(self.work))
                    return self.entry
        # fallback: any server-side file mentioning event-stream
        for p in self.work.rglob('*.js'):
            rp = str(p.relative_to(self.work))
            if any(x in rp for x in ('client', 'frontend', 'public', 'node_modules')):
                continue
            if 'text/event-stream' in p.read_text(errors='ignore'):
                self.entry = rp
                return rp
        return None

    # -- boot --------------------------------------------------------------
    def boot(self):
        if not self.entry and not self.find_entry():
            self.notes.append('no_entry_found')
            return False
        log(f'   \tbooting server entry: {self.entry}')
        # run from the entry's nearest package root, so cwd-relative paths
        # (express.static('client'), data dirs) resolve as the author intended
        entry_path = self.work / self.entry
        run_cwd = self.work
        for parent in entry_path.parents:
            if (parent / 'package.json').is_file():
                run_cwd = parent
                break
            if parent == self.work:
                break
        entry_rel = str(entry_path.relative_to(run_cwd))
        logf = open(self.work / 'grader-server.log', 'ab')
        self.proc = subprocess.Popen(['node', entry_rel], cwd=run_cwd,
                                     stdout=logf, stderr=logf,
                                     start_new_session=True)
        # dir-assumption retry: if process dies citing a missing path, mkdir it once
        time.sleep(3)
        if self.proc.poll() is not None:
            txt = (self.work / 'grader-server.log').read_text(errors='ignore')
            m = re.search(r"path: '([^']+)'", txt) or re.search(r"ENOENT.*?'([^']+)'", txt)
            if m:
                Path(m.group(1)).mkdir(parents=True, exist_ok=True)
                self.notes.append(f'dir_assumption_fixed:{m.group(1)}')
                self.proc = subprocess.Popen(['node', entry_rel], cwd=run_cwd,
                                             stdout=logf, stderr=logf,
                                             start_new_session=True)
            else:
                self.notes.append('boot_crash')
                return False
        port = wait_for(lambda: (free_localhost_ports_of(self.proc.pid) or [None])[0],
                        self.boot_timeout, 0.5)
        if not port:
            self.stop()
            # late dir-assumption retry: the process can outlive the 3s death poll
            # and then die on a missing path (e.g. PGLite creating its data dir
            # after the slow WASM load). Same registered accommodation as above,
            # one retry total (guarded by the note).
            txt = (self.work / 'grader-server.log').read_text(errors='ignore')
            m = re.search(r"path: '([^']+)'", txt) or re.search(r"ENOENT.*?'([^']+)'", txt)
            if m and not any(n.startswith('dir_assumption_fixed') for n in self.notes):
                Path(m.group(1)).mkdir(parents=True, exist_ok=True)
                self.notes.append(f'dir_assumption_fixed:{m.group(1)}')
                return self.boot()
            self.notes.append('no_listen')
            return False
        self.port = port
        log(f'   \tbooted on port: {self.port}')
        time.sleep(1.5)  # PGLite warm-up
        return True

    def restart(self):
        """Kill -9 and boot again from the same workdir (persistence probe)."""
        self.stop(hard=True)
        time.sleep(1)
        return self.boot()

    def stop(self, hard=False):
        if self.proc and self.proc.poll() is None:
            try:
                log(f'   \tstopping server process (pid: {self.proc.pid})')
                os.killpg(self.proc.pid, signal.SIGKILL if hard else signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try: os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass

    def server_log_tail(self, n=400):
        p = self.work / 'grader-server.log'
        return p.read_text(errors='ignore')[-n:] if p.exists() else ''

# ----------------------------------------------------------------------------
# static spec-fidelity checks (shared)
# ----------------------------------------------------------------------------

def collect_package_json(app_dir):
    deps = {}
    for pj in Path(app_dir).rglob('package.json'):
        if 'node_modules' in pj.parts:
            continue
        try:
            d = json.loads(pj.read_text())
        except Exception:
            continue
        deps.update(d.get('dependencies', {}))
        deps.update(d.get('devDependencies', {}))
    return deps

def grep_sources(app_dir, *patterns):
    hits = {p: False for p in patterns}
    for root, dirs, files in os.walk(app_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if not f.endswith(('.js', '.mjs', '.cjs', '.ts', '.html')):
                continue
            try:
                t = (Path(root) / f).read_text(errors='ignore')
            except Exception:
                continue
            for p in patterns:
                if not hits[p] and re.search(p, t, re.I):
                    hits[p] = True
    return hits

def static_fidelity(app_dir):
    """Spec-fidelity checks common to all three specs (mandated stack)."""
    deps = collect_package_json(app_dir)
    src = grep_sources(app_dir, r'pglite', r'text/event-stream', r'EventSource',
                       r'\bsqlite', r'socket\.io|require\([\'"]ws[\'"]\)|from [\'"]ws[\'"]')
    return {
        'dep_pglite': '@electric-sql/pglite' in deps,
        'dep_express': 'express' in deps,
        'dep_cors': 'cors' in deps,
        'forbidden_db_dep': any(k in deps for k in ('sqlite3', 'better-sqlite3', 'pg', 'mysql2', 'mongodb')),
        'uses_pglite_src': src[r'pglite'],
        'sse_server_src': src[r'text/event-stream'],
        'sse_client_src': src[r'EventSource'],
        'uses_sqlite_src': src[r'\bsqlite'],
        'uses_websocket_src': src[r'socket\.io|require\([\'"]ws[\'"]\)|from [\'"]ws[\'"]'],
    }

# ----------------------------------------------------------------------------
# task modules
# ----------------------------------------------------------------------------

class Probe:
    def __init__(self, name, weight, critical=False):
        self.name, self.weight, self.critical = name, weight, critical

class TaskModule:
    """Subclass per spec. Implement probes() returning [(Probe, fn(app)->(ok, evidence))]."""
    name = 'base'
    STREAM_PATHS = ['/api/stream', '/api/events', '/api/sse', '/events', '/stream']

    def detect_stream_path(self, app):
        for p in self.STREAM_PATHS:
            c = SSEClient(app.port, p)
            c.start(); time.sleep(1.2)
            ok = c.status == 200 and 'text/event-stream' in c.headers.get('content-type', '')
            c.stop(); c.join(timeout=2)
            if ok:
                return p
        return None

    def open_sse(self, app, path):
        c = SSEClient(app.port, path)
        c.start()
        time.sleep(1.0)
        return c

# ---------------------------- message board --------------------------------

class MessageBoard(TaskModule):
    name = 'message-board'

    def probes(self):
        return [
            (Probe('post_message', 2, critical=True), self.p_post),
            (Probe('get_messages', 2, critical=True), self.p_get),
            (Probe('sse_endpoint', 1), self.p_sse_endpoint),
            (Probe('sse_broadcast', 3), self.p_broadcast),
            (Probe('sse_multi_client', 2), self.p_multi_client),
            (Probe('persistence_restart', 3), self.p_persistence),
            (Probe('rejects_empty', 1), self.p_validation),
        ]

    @staticmethod
    def _msg_list(data):
        if isinstance(data, list): return data
        if isinstance(data, dict):
            for k in ('messages', 'data', 'items', 'rows'):
                if isinstance(data.get(k), list): return data[k]
        return None

    def p_post(self, app):
        st, d, _ = http_json('POST', app.port, '/api/messages', {'text': 'grader-msg-1'})
        return 200 <= st < 300, f'status={st} body={str(d)[:120]}'

    def p_get(self, app):
        st, d, _ = http_json('GET', app.port, '/api/messages')
        lst = self._msg_list(d)
        ok = st == 200 and lst is not None and any('grader-msg-1' in json.dumps(m) for m in lst)
        return ok, f'status={st} n={len(lst) if lst is not None else "?"}'

    def p_sse_endpoint(self, app):
        self.stream_path = self.detect_stream_path(app)
        return self.stream_path is not None, f'path={self.stream_path}'

    def p_broadcast(self, app):
        if not getattr(self, 'stream_path', None): return False, 'no stream path'
        c = self.open_sse(app, self.stream_path)
        http_json('POST', app.port, '/api/messages', {'text': 'grader-live-7Q'})
        got = wait_for(lambda: any('grader-live-7Q' in b for b in c.data_blobs()), 8)
        c.stop(); c.join(timeout=2)
        return bool(got), f'events={len(c.events)}'

    def p_multi_client(self, app):
        if not getattr(self, 'stream_path', None): return False, 'no stream path'
        c1, c2 = self.open_sse(app, self.stream_path), self.open_sse(app, self.stream_path)
        http_json('POST', app.port, '/api/messages', {'text': 'grader-multi-9Z'})
        ok = wait_for(lambda: all(any('grader-multi-9Z' in b for b in c.data_blobs())
                                  for c in (c1, c2)), 8)
        for c in (c1, c2): c.stop()
        return bool(ok), f'c1={len(c1.events)} c2={len(c2.events)}'

    def p_persistence(self, app):
        log(f'   \tVerifying msg_persistence by restarting app')
        http_json('POST', app.port, '/api/messages', {'text': 'grader-persist-3X'})
        time.sleep(1.5)  # allow async flush
        if not app.restart():
            return False, 'failed to reboot: ' + app.server_log_tail(150)
        st, d, _ = http_json('GET', app.port, '/api/messages')
        lst = self._msg_list(d) or []
        return any('grader-persist-3X' in json.dumps(m) for m in lst), f'n_after_restart={len(lst)}'

    def p_validation(self, app):
        st, _, _ = http_json('POST', app.port, '/api/messages', {'text': ''})
        st2, _, _ = http_json('POST', app.port, '/api/messages', {})
        return (st >= 400) or (st2 >= 400), f'empty={st} missing={st2}'

# ------------------------------- kanban ------------------------------------

class Kanban(TaskModule):
    name = 'kanban-board'

    def probes(self):
        return [
            (Probe('board_state', 2, critical=True), self.p_board),
            (Probe('create_card', 2, critical=True), self.p_create),
            (Probe('move_card', 3), self.p_move),
            (Probe('reorder_within_column', 3), self.p_reorder),
            (Probe('sse_endpoint', 1), self.p_sse_endpoint),
            (Probe('sse_mutation_broadcast', 3), self.p_broadcast),
            (Probe('persistence_restart', 3), self.p_persistence),
            (Probe('ordering_integrity_stress', 3), self.p_stress),
        ]

    # ---- board helpers (tolerant to shape variants) ----
    def board(self, app):
        st, d, _ = http_json('GET', app.port, '/api/board')
        if st != 200: return None
        cols = d.get('columns') if isinstance(d, dict) else d
        if not isinstance(cols, list) or not cols: return None
        return cols

    @staticmethod
    def cards_of(col):
        return col.get('cards', []) if isinstance(col, dict) else []

    def find_card(self, cols, text):
        for c in cols:
            for card in self.cards_of(c):
                if card.get('text') == text:
                    return c, card
        return None, None

    def create_card(self, app, col_id, text):
        bodies = [{'columnId': col_id, 'text': text},
                  {'column_id': col_id, 'text': text},
                  {'columnId': col_id, 'column_id': col_id, 'text': text}]
        paths = ['/api/cards', f'/api/columns/{col_id}/cards']
        for p in paths:
            for b in bodies:
                st, d, _ = http_json('POST', app.port, p, b)
                if 200 <= st < 300:
                    return True, p
        return False, None

    def move_card(self, app, card_id, col_id, before_id=None, after_id=None):
        body = {'columnId': col_id, 'column_id': col_id,
                'beforeId': before_id, 'afterId': after_id,
                'before_id': before_id, 'after_id': after_id}
        attempts = [('PATCH', f'/api/cards/{card_id}/move'),
                    ('POST',  f'/api/cards/{card_id}/move'),
                    ('PUT',   f'/api/cards/{card_id}/move'),
                    ('PATCH', f'/api/cards/{card_id}')]
        for m, p in attempts:
            st, d, _ = http_json(m, app.port, p, body)
            if 200 <= st < 300:
                return True, f'{m} {p}'
        return False, f'last={st}'

    # ---- probes ----
    def p_board(self, app):
        cols = self.board(app)
        self.cols = cols
        return cols is not None and len(cols) >= 3, f'n_cols={len(cols) if cols else 0}'

    def p_create(self, app):
        cols = self.board(app)
        if not cols: return False, 'no board'
        cid = cols[0].get('id')
        ok, path = self.create_card(app, cid, 'grader-card-A')
        ok2, _ = self.create_card(app, cid, 'grader-card-B')
        cols = self.board(app)
        _, found = self.find_card(cols or [], 'grader-card-A')
        self.create_path = path
        return ok and ok2 and found is not None, f'path={path}'

    def p_move(self, app):
        cols = self.board(app)
        if not cols: return False, 'no board'
        col_a, card = self.find_card(cols, 'grader-card-A')
        if not card: return False, 'card A missing'
        target = next((c for c in cols if c.get('id') != col_a.get('id')), None)
        if not target: return False, 'no second column'
        ok, how = self.move_card(app, card.get('id'), target.get('id'))
        cols = self.board(app)
        new_col, found = self.find_card(cols or [], 'grader-card-A')
        moved = found is not None and new_col.get('id') == target.get('id')
        # exactly-one-place check
        count = sum(1 for c in cols or [] for k in self.cards_of(c) if k.get('text') == 'grader-card-A')
        return ok and moved and count == 1, f'{how} moved={moved} copies={count}'

    def p_reorder(self, app):
        cols = self.board(app)
        if not cols: return False, 'no board'
        col, _ = self.find_card(cols, 'grader-card-B')
        if not col: return False, 'card B missing'
        # put B after A's old column ordering: just create C in same col and move B after C
        self.create_card(app, col.get('id'), 'grader-card-C')
        cols = self.board(app)
        col, b = self.find_card(cols, 'grader-card-B')
        _, c = self.find_card(cols, 'grader-card-C')
        if not (b and c): return False, 'setup failed'
        ok, how = self.move_card(app, b.get('id'), col.get('id'), after_id=c.get('id'))
        cols = self.board(app)
        col2, _ = self.find_card(cols or [], 'grader-card-B')
        texts = [k.get('text') for k in self.cards_of(col2 or {})]
        ok_order = texts and texts.index('grader-card-C') < texts.index('grader-card-B') \
                   if ('grader-card-B' in texts and 'grader-card-C' in texts) else False
        return ok and ok_order, f'{how} order={texts[:6]}'

    def p_sse_endpoint(self, app):
        self.stream_path = self.detect_stream_path(app)
        return self.stream_path is not None, f'path={self.stream_path}'

    def p_broadcast(self, app):
        if not getattr(self, 'stream_path', None): return False, 'no stream path'
        cols = self.board(app)
        if not cols: return False, 'no board'
        c = self.open_sse(app, self.stream_path)
        self.create_card(app, cols[0].get('id'), 'grader-live-K1')
        got = wait_for(lambda: any('grader-live-K1' in b for b in c.data_blobs()), 8)
        c.stop(); c.join(timeout=2)
        return bool(got), f'events={len(c.events)}'

    def p_persistence(self, app):
        cols = self.board(app)
        if not cols: return False, 'no board'
        self.create_card(app, cols[0].get('id'), 'grader-persist-K9')
        time.sleep(1.5)
        if not app.restart():
            return False, 'failed to reboot: ' + app.server_log_tail(150)
        cols = self.board(app)
        _, found = self.find_card(cols or [], 'grader-persist-K9')
        return found is not None, 'survived restart' if found else 'lost after restart'

    def p_stress(self, app):
        """Insert 25 cards then repeatedly move the last between the first two.
        Checks total ordering stays valid (unique positions, no dup/loss)."""
        cols = self.board(app)
        if not cols: return False, 'no board'
        cid = cols[0].get('id')
        for i in range(25):
            self.create_card(app, cid, f'grader-stress-{i}')
        cols = self.board(app)
        col = next((c for c in cols if c.get('id') == cid), None)
        cards = self.cards_of(col)
        s0, s1 = (k for k in cards if k.get('text') in ('grader-stress-0', 'grader-stress-1'))
        mover = next(k for k in cards if k.get('text') == 'grader-stress-24')
        for _ in range(12):  # repeated midpoint insertion between the same two cards
            self.move_card(app, mover.get('id'), cid, before_id=s1.get('id'), after_id=s0.get('id'))
            self.move_card(app, mover.get('id'), cid, before_id=None, after_id=None)
        cols = self.board(app)
        col = next((c for c in cols or [] if c.get('id') == cid), None)
        cards = self.cards_of(col)
        texts = [k.get('text') for k in cards]
        n_stress = sum(1 for t in texts if t and t.startswith('grader-stress-'))
        positions = [k.get('position') for k in cards if k.get('position') is not None]
        unique = len(positions) == len(set(positions))
        valid = all(isinstance(p, (int, float)) and p == p for p in positions)  # no NaN
        return n_stress == 25 and unique and valid, \
               f'n={n_stress}/25 unique_pos={unique} valid_pos={valid}'

# ----------------------------- seat booking --------------------------------

class SeatBooking(TaskModule):
    name = 'seat-booking'

    def probes(self):
        return [
            (Probe('seat_map', 2, critical=True), self.p_map),
            (Probe('hold_acquire', 2, critical=True), self.p_hold),
            (Probe('hold_blocks_others', 3), self.p_conflict),
            (Probe('all_or_nothing', 3), self.p_atomic),
            (Probe('confirm_books', 2), self.p_confirm),
            (Probe('confirm_idempotent', 3), self.p_idempotent),
            (Probe('release_hold', 2), self.p_release),
            (Probe('confirm_unknown_fails', 2), self.p_bad_confirm),
            (Probe('concurrent_double_book', 4), self.p_race),
            (Probe('seat_count_invariant', 2), self.p_invariant),
            (Probe('sse_endpoint', 1), self.p_sse_endpoint),
            (Probe('sse_transition_broadcast', 3), self.p_broadcast),
            (Probe('persistence_restart', 3), self.p_persistence),
        ]

    # ---- helpers ----
    def seats(self, app):
        st, d, _ = http_json('GET', app.port, '/api/seats')
        if st != 200: return None
        lst = d if isinstance(d, list) else (d.get('seats') if isinstance(d, dict) else None)
        return lst if isinstance(lst, list) else None

    @staticmethod
    def status_of(s):
        return str(s.get('status', s.get('state', ''))).lower()

    def available(self, app):
        return [s for s in (self.seats(app) or []) if self.status_of(s) == 'available']

    def hold(self, app, seat_ids, session='grader-s1'):
        bodies = [{'seatIds': seat_ids, 'sessionId': session},
                  {'seat_ids': seat_ids, 'session_id': session},
                  {'seatIds': seat_ids, 'sessionId': session, 'seats': seat_ids}]
        for b in bodies:
            st, d, _ = http_json('POST', app.port, '/api/holds', b)
            if st != 404:
                return st, d
        return st, d

    @staticmethod
    def hold_id_of(d):
        if not isinstance(d, dict): return None
        for k in ('id', 'holdId', 'hold_id'):
            if k in d: return d[k]
        h = d.get('hold')
        if isinstance(h, dict):
            for k in ('id', 'holdId', 'hold_id'):
                if k in h: return h[k]
        return None

    # ---- probes ----
    def p_map(self, app):
        seats = self.seats(app)
        ok = seats is not None and len(seats) >= 10 and \
             all(self.status_of(s) in ('available', 'held', 'booked') for s in seats[:5])
        return ok, f'n_seats={len(seats) if seats else 0}'

    def p_hold(self, app):
        av = self.available(app)
        if len(av) < 2: return False, 'no available seats'
        ids = [av[0].get('id'), av[1].get('id')]
        st, d = self.hold(app, ids)
        self.h1 = self.hold_id_of(d)
        self.h1_seats = ids
        return 200 <= st < 300 and self.h1 is not None, f'status={st} hold_id={self.h1}'

    def p_conflict(self, app):
        if not getattr(self, 'h1_seats', None): return False, 'no prior hold'
        st, d = self.hold(app, [self.h1_seats[0]], session='grader-s2')
        return st == 409 or st >= 400, f'status={st}'

    def p_atomic(self, app):
        av = self.available(app)
        if not av or not getattr(self, 'h1_seats', None): return False, 'setup'
        free_id = av[0].get('id')
        st, d = self.hold(app, [free_id, self.h1_seats[0]], session='grader-s3')  # one free + one held
        seats = self.seats(app) or []
        free_now = next((s for s in seats if s.get('id') == free_id), {})
        untouched = self.status_of(free_now) == 'available'
        return st >= 400 and untouched, f'status={st} free_seat_after={self.status_of(free_now)}'

    def p_confirm(self, app):
        if not getattr(self, 'h1', None): return False, 'no hold'
        st, d, _ = http_json('POST', app.port, f'/api/holds/{self.h1}/confirm', {})
        seats = self.seats(app) or []
        booked = [s for s in seats if s.get('id') in self.h1_seats and self.status_of(s) == 'booked']
        return 200 <= st < 300 and len(booked) == len(self.h1_seats), \
               f'status={st} booked={len(booked)}/{len(self.h1_seats)}'

    def p_idempotent(self, app):
        if not getattr(self, 'h1', None): return False, 'no hold'
        st1, _, _ = http_json('POST', app.port, f'/api/holds/{self.h1}/confirm', {})
        st2, _, _ = http_json('POST', app.port, f'/api/holds/{self.h1}/confirm', {})
        seats = self.seats(app) or []
        booked = [s for s in seats if self.status_of(s) == 'booked']
        ok = len(booked) == len(self.h1_seats)  # still exactly the original seats
        return ok and st1 < 500 and st2 < 500, f're-confirm={st1},{st2} total_booked={len(booked)}'

    def p_release(self, app):
        av = self.available(app)
        if not av: return False, 'no seats'
        sid = av[0].get('id')
        st, d = self.hold(app, [sid], session='grader-s4')
        hid = self.hold_id_of(d)
        if not hid: return False, f'hold failed {st}'
        st2, _, _ = http_json('DELETE', app.port, f'/api/holds/{hid}')
        seats = self.seats(app) or []
        seat = next((s for s in seats if s.get('id') == sid), {})
        return st2 < 400 and self.status_of(seat) == 'available', \
               f'release={st2} status_after={self.status_of(seat)}'

    def p_bad_confirm(self, app):
        st, _, _ = http_json('POST', app.port, '/api/holds/grader-nonexistent/confirm', {})
        seats = self.seats(app) or []
        booked_before = len([s for s in seats if self.status_of(s) == 'booked'])
        return st >= 400, f'status={st} booked={booked_before}'

    def p_race(self, app):
        """The core concurrency probe: N parallel holds on one seat -> exactly one 2xx."""
        av = self.available(app)
        if not av: return False, 'no seats'
        sid = av[0].get('id')
        results = []
        def worker(i):
            st, d = self.hold(app, [sid], session=f'grader-race-{i}')
            results.append(st)
        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads: t.start()
        for t in threads: t.join(timeout=15)
        wins = sum(1 for st in results if 200 <= st < 300)
        seats = self.seats(app) or []
        seat = next((s for s in seats if s.get('id') == sid), {})
        return wins == 1 and self.status_of(seat) == 'held', \
               f'wins={wins}/{len(results)} statuses={sorted(set(results))} seat={self.status_of(seat)}'

    def p_invariant(self, app):
        seats = self.seats(app) or []
        n = len(seats)
        counted = sum(1 for s in seats if self.status_of(s) in ('available', 'held', 'booked'))
        return n > 0 and counted == n, f'{counted}/{n} in valid states'

    def p_sse_endpoint(self, app):
        self.stream_path = self.detect_stream_path(app)
        return self.stream_path is not None, f'path={self.stream_path}'

    def p_broadcast(self, app):
        if not getattr(self, 'stream_path', None): return False, 'no stream path'
        av = self.available(app)
        if not av: return False, 'no seats'
        c = self.open_sse(app, self.stream_path)
        sid = av[0].get('id')
        self.hold(app, [sid], session='grader-sse')
        got = wait_for(lambda: any(str(sid) in b for b in c.data_blobs()), 8)
        c.stop(); c.join(timeout=2)
        return bool(got), f'events={len(c.events)}'

    def p_persistence(self, app):
        seats_before = self.seats(app) or []
        booked_before = {s.get('id') for s in seats_before if self.status_of(s) == 'booked'}
        time.sleep(1.5)
        if not app.restart():
            return False, 'failed to reboot: ' + app.server_log_tail(150)
        seats_after = self.seats(app) or []
        booked_after = {s.get('id') for s in seats_after if self.status_of(s) == 'booked'}
        return booked_before and booked_before == booked_after, \
               f'booked before={len(booked_before)} after={len(booked_after)}'

# ----------------------------------------------------------------------------
# orchestration
# ----------------------------------------------------------------------------

TASKS = {'message-board': MessageBoard, 'kanban-board': Kanban, 'seat-booking': SeatBooking}

# Rubric/task keys for specs whose API modules are not yet implemented: they are
# graded via boot + visual rubric merge. Maps path keyword -> rubric task name.
RUBRIC_ONLY_TASKS = {
    'calendar': 'calendar-week-view',
    'dashboard': 'metrics-dashboard',
    'brownfield': 'kanban-labels-brownfield',
    'labels': 'kanban-labels-brownfield',
    'log-explorer': 'log-explorer-perf',
}


class GenericBoot(TaskModule):
    """Fallback module for rubric-only specs: verifies boot, runs no API probes."""
    name = 'generic'

    def probes(self):
        return []


# Rubric-only specs that can nevertheless reuse an existing probe module.
# kanban-labels-brownfield: half its graded acceptance criteria are REGRESSIONS of the
# original kanban board (create/move/reorder/SSE/persistence/ordering-stress), which the
# Kanban module probes verbatim - so functional_pct on brownfield runs measures the
# regression half. The labels half is graded by the visual rubric (BL-V1..V5); label
# API probes are future work.
GENERIC_MODULE_OVERRIDES = {'kanban-labels-brownfield': 'kanban-board'}


def detect_task(path):
    p = str(path).lower()
    for kw, rubric in RUBRIC_ONLY_TASKS.items():
        if kw in p:
            return 'generic:' + rubric
    for k in TASKS:
        if k in p:
            return k
    return None

def rubric_dir_default():
    return Path(__file__).resolve().parent / 'rubrics'


def load_rubric(task_key, rubric_dir):
    """Return the rubric definition dict for a task key, or None."""
    if task_key.startswith('generic:'):
        name = task_key.split(':', 1)[1]
    else:
        name = task_key   # task keys are full spec names = rubric file names
    f = Path(rubric_dir) / f'{name}.rubric.json'
    if f.exists():
        try:
            return json.loads(f.read_text())
        except json.JSONDecodeError as e:
            log(f'WARNING: unparseable rubric {f}: {e}')
    return None


def scores_path_for(run_dir):
    """visual-scores.json lives next to the manifest when possible."""
    run_dir = Path(run_dir)
    for cand in (run_dir / 'smoke/logs', run_dir / 'logs', run_dir):
        if cand.is_dir():
            return cand / 'visual-scores.json'
    return run_dir / 'visual-scores.json'


def emit_scorecard(run_dir, rubric):
    """Write a blank scorecard for the human grader (never overwrites a filled one)."""
    sp = scores_path_for(run_dir)
    if sp.exists():
        return False
    card = {
        '_instructions': ('Fill score with pass|partial|fail|skip for each item. '
                          'Grade CONDITION-BLIND: do not read manifest.json first. '
                          'If the app does NOT boot/run at all, score every item FAIL '
                          '(criteria unmet) - do not skip; skip is only for grader-side '
                          'problems (your environment, not the artifact). '
                          'See the matching .rubric.md for setup steps and criteria. '
                          'Scoring is applied later by merge_results.py.'),
        '_task': rubric['task'],
        'grader_name': '',
        'items': {it['id']: {'score': '', 'criterion': it['criterion'],
                             'weight': it['weight'], 'notes': ''}
                  for it in rubric['items']},
    }
    sp.write_text(json.dumps(card, indent=2))
    return True


# NOTE: human/visual scoring is intentionally NOT done here. This grader emits
# a blank card (emit_scorecard, above); the filled cards are scored once, in
# merge_results.py. See guidelines/pipeline-refactor-design.md.


# Verification tools whose usage counts are reported per run. Uptake is a FIRST-CLASS
# OUTCOME: a visual-condition run with screenshot_calls == 0 received the treatment
# but did not take it (noncompliance) - that is data about the model, and the analysis
# rules in guidelines/research-context.md depend on these counts being in the results.
VERIFICATION_TOOLS = ("screenshot", "check_boot", "start_app", "start_server",
                      "run_tests", "run_typecheck", "run_lint", "run_command",
                      "run_background_command", "run_command_and_capture_output")


def tool_uptake(run_dir):
    """Count verification-tool calls from the run's commands.json (None if absent)."""
    run_dir = Path(run_dir)
    for cand in (run_dir / 'smoke/logs/commands.json', run_dir / 'logs/commands.json',
                 run_dir / 'commands.json'):
        if cand.exists():
            try:
                cmds = json.loads(cand.read_text())
            except json.JSONDecodeError:
                return None
            counts = {}
            for c in cmds:
                t = c.get('tool')
                if t in VERIFICATION_TOOLS:
                    counts[t] = counts.get(t, 0) + 1
            return counts
    return None


# ----------------------------------------------------------------------------
# Static defect scan: detects BOTH defect classes without executing anything, so a
# first-boot failure of one class cannot mask defects of the other class.
#   logic-class   : syntax errors (`node --check` per authored file)
#   env/packaging : imports of packages never declared in any package.json, and
#                   relative imports pointing at files that don't exist
# Runtime-only logic errors (e.g. ReferenceError) are NOT statically catchable; boot
# classification covers the first of those. Use class PRESENCE per run in analysis,
# not total counts - enumeration beyond the first runtime failure is not attempted.
# ----------------------------------------------------------------------------
_NODE_BUILTINS = {'fs', 'path', 'http', 'https', 'crypto', 'url', 'events', 'os',
                  'util', 'stream', 'child_process', 'net', 'zlib', 'assert', 'dns',
                  'buffer', 'querystring', 'readline', 'cluster', 'worker_threads',
                  'process', 'timers', 'tls', 'string_decoder', 'perf_hooks'}

_IMPORT_RE = re.compile(
    r"""(?:require\s*\(\s*|from\s+|import\s*\(\s*|^import\s+)['"]([^'"]+)['"]""",
    re.M)


def static_defect_scan(app_dir):
    """Return {'syntax_errors': [...], 'undeclared_imports': [...], 'broken_relative_imports': [...]}."""
    app_dir = Path(app_dir)
    declared = set(collect_package_json(app_dir))
    out = {'syntax_errors': [], 'undeclared_imports': [], 'broken_relative_imports': []}
    for root, dirs, files in os.walk(app_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and d != '.agent_logs']
        for fn in files:
            if not fn.endswith(('.js', '.mjs', '.cjs')):
                continue
            f = Path(root) / fn
            rel = str(f.relative_to(app_dir))
            r = subprocess.run(['node', '--check', str(f)],
                               capture_output=True, text=True, timeout=20)
            if r.returncode != 0:
                first = (r.stderr or '').strip().splitlines()
                out['syntax_errors'].append(
                    {'file': rel, 'error': first[-1][:120] if first else 'unknown'})
            try:
                text = f.read_text(errors='replace')
            except OSError:
                continue
            for spec in _IMPORT_RE.findall(text):
                if spec.startswith(('.', '/')):
                    base = (f.parent / spec).resolve()
                    if not any((base.parent / (base.name + ext)).exists()
                               for ext in ('', '.js', '.mjs', '.cjs', '.json')) \
                            and not (base / 'index.js').exists():
                        out['broken_relative_imports'].append({'file': rel, 'import': spec})
                else:
                    pkg = spec.split('/')[0] if not spec.startswith('@') \
                        else '/'.join(spec.split('/')[:2])
                    if pkg.replace('node:', '') not in _NODE_BUILTINS \
                            and pkg not in declared:
                        out['undeclared_imports'].append({'file': rel, 'package': pkg})
    # de-duplicate
    for k in out:
        seen, uniq = set(), []
        for d in out[k]:
            t = tuple(sorted(d.items()))
            if t not in seen:
                seen.add(t); uniq.append(d)
        out[k] = uniq
    return out


# Boot-failure classes: WHY an artifact failed to boot is data (H5 predicts the
# baseline's failures are environment-class, not logic-class). Matched against the
# captured server log, in order.
_BOOT_FAILURE_CLASSES = [
    ("module_not_found",  r"ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module"),
    ("syntax_error",      r"SyntaxError"),
    ("reference_error",   r"ReferenceError|TypeError|is not defined|is not a function"),
    ("missing_path",      r"ENOENT|no such file or directory"),
    ("port_conflict",     r"EADDRINUSE|address already in use"),
    ("db_init_failure",   r"PGlite|pglite|Program terminated with exit"),
]


def classify_boot_failure(server_log: str) -> str:
    for name, pat in _BOOT_FAILURE_CLASSES:
        if re.search(pat, server_log or ""):
            return name
    return "other"


def load_manifest(run_dir):
    for cand in (Path(run_dir) / 'smoke/logs/manifest.json',
                 Path(run_dir).parent / 'smoke/logs/manifest.json'):
        if cand.exists():
            try:
                return json.loads(cand.read_text())
            except Exception:
                pass
    return {}

def grade_one(run_dir, task_key, work_root, install, boot_timeout, keep_work):
    run_dir = Path(run_dir)
    app_dir = run_dir / 'app' if (run_dir / 'app').is_dir() else run_dir
    manifest = load_manifest(run_dir)
    result = {
        'run': str(run_dir),
        'task': task_key,
        'model': manifest.get('model'),
        'condition': manifest.get('condition'),
        'run_status': manifest.get('status'),
        'fidelity': static_fidelity(app_dir),
        'tool_uptake': tool_uptake(run_dir),
        'static_defects': static_defect_scan(app_dir),
        'boot_ok': False, 'notes': [], 'probes': {},
        'functional_score': 0.0, 'functional_max': 0.0, 'fidelity_score': 0.0,
    }
    # fidelity score: mandated stack present, no forbidden substitutes
    f = result['fidelity']
    fid_points = [f['dep_pglite'], f['dep_express'], f['dep_cors'],
                  f['uses_pglite_src'], f['sse_server_src'], f['sse_client_src'],
                  not f['forbidden_db_dep'], not f['uses_websocket_src']]
    result['fidelity_score'] = round(sum(fid_points) / len(fid_points), 3)

    if task_key.startswith('generic:'):
        override = GENERIC_MODULE_OVERRIDES.get(task_key.split(':', 1)[1])
        mod = TASKS[override]() if override else GenericBoot()
    else:
        mod = TASKS[task_key]()
    app = App(app_dir, Path(work_root) / re.sub(r'\W+', '_', str(run_dir))[-60:],
              install=install, boot_timeout=boot_timeout)
    try:
        app.stage()
        result['boot_ok'] = app.boot()
        result['entry'] = app.entry
        result['port'] = app.port
        if result['boot_ok']:
            for probe, fn in mod.probes():
                log_message = f'\tprobe {probe.name}'
                try:
                    ok, evidence = fn(app)
                except Exception as e:
                    ok, evidence = False, f'probe_exception: {e!r}'
                result['probes'][probe.name] = {'ok': bool(ok), 'weight': probe.weight,
                                                'evidence': str(evidence)[:300]}
                result['functional_max'] += probe.weight
                log(f'\tprobe {probe.name}: Ok:{ok} {evidence:100}')
                if ok:
                    result['functional_score'] += probe.weight
                if probe.critical and not ok:
                    result['notes'].append(f'critical_probe_failed:{probe.name}')
        else:
            # Boot failure => every functional probe is unearned: functional_pct
            # becomes 0 (a SCORE, not an exclusion - the run stays in all ITT
            # analyses). fidelity_score and cost are NOT zeroed: static fidelity is
            # measurable on broken code and matters for H2. The failure CLASS is
            # recorded for the environment-vs-logic defect split (H5).
            result['notes'].append('boot_failed')
            result['server_log'] = app.server_log_tail()
            result['boot_failure_class'] = classify_boot_failure(result['server_log'])
            log(f'   \tboot_failed ({result["boot_failure_class"]}): {app.server_log_tail()}')
            for probe, _ in mod.probes():
                result['functional_max'] += probe.weight
    finally:
        app.stop(hard=True)
        result['notes'].extend(app.notes)
        if not keep_work and app.work.exists():
            shutil.rmtree(app.work, ignore_errors=True)
    if result['functional_max']:
        result['functional_pct'] = round(100 * result['functional_score'] / result['functional_max'], 1)
    elif task_key.startswith('generic:'):
        result['functional_pct'] = None      # rubric-only spec: no API probes yet
    else:
        result['functional_pct'] = 0.0
    return result

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('runs', nargs='+', help='run dirs (or app dirs); globs OK')
    ap.add_argument('--task', default='auto', choices=['auto'] + list(TASKS))
    ap.add_argument('--out', default='automatic_probes_results.jsonl')
    ap.add_argument('--csv', default='automatic_probes_results.csv')
    ap.add_argument('--install', action='store_true', help='npm install when node_modules missing')
    ap.add_argument('--keep-work', action='store_true')
    ap.add_argument('--work-root', default='/tmp/grader-work')
    ap.add_argument('--rubric-dir', default=str(rubric_dir_default()),
                    help='directory of <task>.rubric.json definitions')
    ap.add_argument('--emit-scorecards', action='store_true',
                    help='write a blank visual-scores.json next to each run manifest '
                         '(for the human grader to fill; never overwrites)')
    ap.add_argument('--timeout-boot', type=int, default=30)
    args = ap.parse_args()

    run_dirs = []
    for r in args.runs:
        run_dirs.extend(sorted(glob.glob(r)) or [r])

    results = []
    for rd in run_dirs:
        task = args.task if args.task != 'auto' else detect_task(rd)
        if not task:
            log(f'SKIP (cannot detect task): {rd}')
            continue
        rubric = load_rubric(task, args.rubric_dir)
        if args.emit_scorecards and rubric:
            if emit_scorecard(rd, rubric):
                log(f'  scorecard emitted for {rd}')
        log(f'grading [{task}] {rd}')
        res = grade_one(rd, task, args.work_root, args.install, args.timeout_boot, args.keep_work)
        # machine-only: no visual/overall here; human scoring is applied by merge_results.py
        log(f"  -> boot={res['boot_ok']} functional={res['functional_pct']}% "
            f"fidelity={res['fidelity_score']}")
        results.append(res)
        with open(args.out, 'a') as fh:
            fh.write(json.dumps(res) + '\n')

    if results:
        probe_names = sorted({p for r in results for p in r['probes']})
        with open(args.csv, 'w', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(['run', 'task', 'model', 'condition', 'run_status', 'boot_ok',
                        'functional_pct', 'fidelity_score',
                        'screenshot_calls'] + probe_names)
            for r in results:
                up = r.get('tool_uptake')
                w.writerow([r['run'], r['task'], r['model'], r['condition'], r['run_status'],
                            r['boot_ok'], r['functional_pct'], r['fidelity_score'],
                            (up or {}).get('screenshot', '') if up is not None else ''] +
                           [r['probes'].get(p, {}).get('ok', '') for p in probe_names])
        log(f'wrote {args.out} and {args.csv} ({len(results)} runs)')

if __name__ == '__main__':
    main()
