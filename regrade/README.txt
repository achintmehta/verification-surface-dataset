Re-grade working directory. Protocol: REGRADE_RUNBOOK.md (repo root).

Order of operations
  1. build regrade/exclusions.csv by hand   (runbook step 1)
  2. python3 regrade/draw_sample.py --seed 20260812 --n 112 \
             --exclude regrade/exclusions.csv --out regrade/_sealed/sample.csv
  3. python3 regrade/stage.py --inspect     (confirm card blanking, writes nothing)
  4. python3 regrade/stage.py --seed 20260812
  5. python3 regrade/status.py              (what to grade next)
     python3 regrade/serve.py R0xx          (opens that app, redacted output)
     ...score into regrade/R0xx/card.json, log the date in SESSIONS.txt
  6. analysis - runbook step 5

DO NOT OPEN regrade/_sealed/ until every card is scored. It holds sample.csv
and MAPPING.csv, both of which name conditions.

Nothing here copies an app. serve.py runs each app where it already lives and
redacts the path, the task name and the condition from everything it prints.
