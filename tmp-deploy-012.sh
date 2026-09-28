#!/bin/bash
set -e
cd /opt/xianyu-monitor
docker compose pull 2>&1 | tail -1 | sed 's/^/  /'
docker compose up -d 2>&1 | tail -1 | sed 's/^/  /'
sleep 8
PW=$(grep '^WEB_PASSWORD=' .env | cut -d= -f2-)
COOKIE=$(curl -s -i -X POST -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "password=$PW" http://127.0.0.1:7788/login | grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr -d '\r')
curl -s -H "cookie: $COOKIE" http://127.0.0.1:7788/api/state | python3 -c "import json,sys;s=json.load(sys.stdin);print('  session:',s.get('session'),'| running:',s.get('running'))"
echo '--- 部署的代码里是否是新规则 ---'
grep -q 'DIGEST_MIN_ITEMS' src/monitor.mjs && echo '  ✅ 新规则在' || echo '  ❌ 仍是旧规则'
grep -c 'item.url' src/monitor.mjs | sed 's/^/  汇总里带链接的处数: /'
