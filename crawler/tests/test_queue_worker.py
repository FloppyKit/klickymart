import json, os, sys, tempfile, unittest, types
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import queue_worker as qw
FIX = os.path.join(os.path.dirname(__file__), "fixtures", "submit-queue.sample.ndjson")

class R:  # fake CompletedProcess
    def __init__(self, rc=0, out="", err=""): self.returncode, self.stdout, self.stderr = rc, out, err

class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.calls = []; self.posts = []
        self.tok = os.path.join(self.tmp, "tok"); open(self.tok, "w").write("SECRET-TEST-TOKEN")
    def fake_run(self, cmd):
        self.calls.append(cmd)
        if cmd[0] == "crawl.py":
            d = os.path.basename(cmd[cmd.index("--out") + 1])
            os.makedirs(os.path.join(os.path.dirname(cmd[1]), d), exist_ok=True)
            if d == "broken.example": return R(1, err="Timeout 30000ms")
            with open(os.path.join(os.path.dirname(cmd[1]), d, "records.jsonl"), "w") as f: f.write(json.dumps({"d": d, "status": "crawled", "ar": []}) + "\n")
        return R(0, out="signed=1 skipped=0 verified=1")
    def verdict(self, d): return {"status": "blocked-tos", "tos": "bans-automation", "src": "gate_blocklist.json"} if d == "wacaco.com" else {}

    def test_dry_run_touches_nothing(self):
        res = qw.process(qw.read_queue(FIX), self.tmp, run=self.fake_run, verdict=self.verdict, dry=True, post=lambda r: self.fail("posted"), log=lambda *_: None)
        self.assertEqual(self.calls, [])
        self.assertEqual([r["status"] for r in res], ["planned", "refused", "planned"])

    def test_live_flow_statuses_local_signing_and_token(self):
        orig = qw.report
        qw.report = lambda i, s, w, post=None: orig(i, s, w, token_path=self.tok, site="https://km.test", post=post)
        try:
            post = lambda req: (self.posts.append(req), 200)[1]
            logs = []
            res = qw.process(qw.read_queue(FIX), self.tmp, run=self.fake_run, verdict=self.verdict, post=post, log=logs.append)
        finally: qw.report = orig
        self.assertEqual([(r["domain"], r["status"]) for r in res], [("roaster.example", "crawled"), ("wacaco.com", "refused"), ("broken.example", "error")])
        # blocklisted domain never reached tos.py / crawl.py
        self.assertFalse(any("wacaco.com" in " ".join(c) for c in self.calls))
        # crawl always with --require-tos, after tos.py
        crawls = [c for c in self.calls if c[0] == "crawl.py"]; self.assertTrue(all("--require-tos" in c for c in crawls))
        self.assertEqual(self.calls[0][0], "tos.py")
        # signed locally only
        self.assertEqual(self.calls[-1][0], "sign_events.py")
        rec = json.loads(open(os.path.join(self.tmp, "records.jsonl")).readline())
        self.assertEqual((rec["src"], rec["trust_tier"], rec["submission_id"]), ("community", "unverified", "sub_0123456789abcdef0123"))
        # status reports: right URL, bearer token sent, token never logged
        self.assertEqual([p.full_url for p in self.posts], [f"https://km.test/submit/queue/{i}/status" for i in ["sub_0123456789abcdef0123", "sub_00000000000000000001", "sub_00000000000000000002"]])
        self.assertEqual(self.posts[0].get_header("Authorization"), "Bearer SECRET-TEST-TOKEN")
        self.assertEqual(json.loads(self.posts[1].data)["status"], "refused")
        self.assertFalse(any("SECRET-TEST-TOKEN" in str(l) for l in logs))
        self.assertNotIn("SECRET-TEST-TOKEN", open(os.path.join(self.tmp, "results.json")).read())

    def test_never_publishes(self):
        src = open(qw.__file__).read()
        for bad in ("publish_events", "wss://", "websocket", "nostr_sdk", "Client("):
            self.assertNotIn(bad, src.split('"""', 2)[2])

    def test_empty_queue_body(self):
        for body in ["", "\n", "  \n\n"]: self.assertEqual(qw.parse_queue(body), [])
        empty = os.path.join(self.tmp, "empty.ndjson"); open(empty, "w").write("")
        self.assertEqual(qw.read_queue(empty), [])
        self.assertEqual(qw.process([], self.tmp, run=self.fake_run, verdict=self.verdict, post=lambda r: self.fail("posted"), log=lambda *_: None), [])
        self.assertEqual(self.calls, [])
        with self.assertRaises(RuntimeError): qw.parse_queue('{"error":{"code":"empty_response"}}')
        self.assertEqual(len(qw.parse_queue('not json\n{"id":"sub_1","domain":"a.example"}')), 1)

    def test_outcome_mapping(self):
        self.assertEqual(qw.outcome({"status": "agents-not-welcome"})[0], "refused")
        self.assertEqual(qw.outcome({"err": "boom"})[0], "error")
        self.assertEqual(qw.outcome(None)[0], "error")

if __name__ == "__main__": unittest.main()
