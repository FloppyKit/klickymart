import os, tempfile
# hermetic: the hand-anomaly ledger's default sink never writes into crawler/out during tests
os.environ.setdefault("KM_HAND_ANOMALIES", os.path.join(tempfile.mkdtemp(prefix="km-ha-"), "hand-anomalies.jsonl"))
