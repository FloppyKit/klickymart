"""Disputed Audit items d1-d3: repro in a fresh interpreter each (install() patches process-wide)."""
import os, subprocess, sys, textwrap
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def run(code):
    p = subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=HERE, capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stdout + p.stderr
    return p.stdout.strip()

def test_d1_failed_proxy_start_retries():
    out = run("""
        import sys; sys.path.insert(0, '.')
        import gate
        calls = []
        def boom(): calls.append(1); raise RuntimeError('proxy failed')
        gate.start_egress_proxy = boom
        for _ in range(2):
            try: gate.install()
            except RuntimeError: pass
        print(len(calls), gate._installed)
    """)
    assert out == "2 False", out   # second install() must retry, and a failed install is not marked installed

def test_d2_partial_playwright_import_failure_is_loud():
    out = run("""
        import sys, builtins; sys.path.insert(0, '.')
        import gate
        gate.start_egress_proxy = lambda: 'http://127.0.0.1:9'
        real = builtins.__import__
        def imp(name, *a, **k):
            if name == 'playwright.sync_api._generated': raise ImportError('partial')
            return real(name, *a, **k)
        builtins.__import__ = imp
        try: gate.install(); print('silent')
        except ImportError: print('raised')
    """)
    assert out == "raised", out

def test_d3_contexts_block_service_workers():
    out = run("""
        import sys; sys.path.insert(0, '.')
        from playwright.sync_api._generated import Browser, BrowserType
        seen = []
        class Ctx:
            def route(self, *a, **k): pass
        class Pg: context = Ctx()
        Browser.new_context = lambda self, *a, **k: (seen.append(k.get('service_workers')), Ctx())[1]
        Browser.new_page = lambda self, *a, **k: (seen.append(k.get('service_workers')), Pg())[1]
        BrowserType.launch_persistent_context = lambda self, *a, **k: (seen.append(k.get('service_workers')), Ctx())[1]
        import gate
        gate.start_egress_proxy = lambda: 'http://127.0.0.1:9'
        gate.install()
        Browser.new_context(object()); BrowserType.launch_persistent_context(object(), '/tmp/x'); Browser.new_page(object())
        Browser.new_context(object(), service_workers='allow'); BrowserType.launch_persistent_context(object(), '/tmp/x', service_workers='allow')
        Browser.new_page(object(), service_workers='allow')
        print(seen)
    """)
    assert out == "['block', 'block', 'block', 'block', 'block', 'block']", out   # 'allow' is overridden
