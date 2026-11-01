import json, os, random, sys, unittest
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class T(unittest.TestCase):
    def test_20_sample_records_validate(self):
        p = os.path.join(H, "out", "records.v4.jsonl")
        if not os.path.exists(p): self.skipTest("records.v4.jsonl not built")
        import jsonschema
        schema = json.load(open(os.path.join(H, "..", "record.schema.v0.4.json")))
        recs = [json.loads(l) for l in open(p)]
        random.seed(4)
        for r in random.sample(recs, 20): jsonschema.validate(r, schema)
        self.assertTrue(all(r.get("fields_checked") for r in recs))
if __name__ == "__main__": unittest.main()
