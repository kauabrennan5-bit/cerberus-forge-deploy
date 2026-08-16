import json, glob, re

f = sorted(glob.glob('/home/ubuntu/.mcp/tool-results/*execute_sql*'), key=lambda p: p)[-1]
raw = json.load(open(f))
s = raw.get('result', '')
m = re.search(r'<untrusted-data[^>]*>\n(.*?)\n</untrusted-data', s, re.S)
if m:
    print(m.group(1))
else:
    print(s[:600])
