# -*- coding: utf-8 -*-
"""미국 종목 → 핀비즈(finviz.com/map) 섹터·세부 산업 매핑 → data/us_sectors.json

핀비즈 맵의 기초 데이터는 웹팩 청크(JS 모듈)로 정적 배포된다:
  /map HTML → map.v1.<hash>.js (SectorFull 청크 id) → runtime.v1.<hash>.js (id→해시) → 청크 다운로드
전체 시장판(SectorFull, 약 5,500종목)을 파싱해 GICS 11개 섹터(한글)와
세부 산업(핀비즈 원문)을 종목별로 저장한다. 히트맵 API 가 이 파일을 조인한다.

요청 4번 — 파이프라인 전용. 실행: python fetch_us_sectors.py
"""
import os, re, sys, json, datetime, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')
BASE = 'https://finviz.com'

SECTOR_KO = {
    'Financial': '금융', 'Technology': '기술', 'Consumer Cyclical': '경기소비재',
    'Communication Services': '통신 서비스', 'Consumer Defensive': '필수소비재',
    'Healthcare': '헬스케어', 'Industrials': '산업재', 'Real Estate': '부동산',
    'Utilities': '유틸리티', 'Energy': '에너지', 'Basic Materials': '소재',
}
MIN_COUNT = 3000     # 이보다 적게 파싱되면 실패로 보고 직전 파일 보존


def _get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': BASE + '/map?t=sec'})
    return urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'ignore')


def parse_chunk(js):
    """웹팩 청크 안의 e.exports={name:"Root",children:[...]} 리터럴을 JSON 으로."""
    i = js.index('e.exports={')
    lit = js[i + len('e.exports='):]
    depth = 0
    for k, ch in enumerate(lit):
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                lit = lit[:k + 1]
                break
    return json.loads(re.sub(r'([{,])(name|description|children|value):', r'\1"\2":', lit))


def main():
    os.makedirs(OUT, exist_ok=True)
    html = _get(BASE + '/map?t=sec')
    map_src = re.search(r'src="(/assets/dist/map\.v1\.[0-9a-f]+\.js)"', html).group(1)
    rt_src = re.search(r'src="(/assets/dist/runtime\.v1\.[0-9a-f]+\.js)"', html).group(1)
    map_js = _get(BASE + map_src)
    chunk_id = re.search(r'SectorFull:return \w+\(\w+\.e\((\d+)\)', map_js).group(1)
    runtime = _get(BASE + rt_src)
    chunk_hash = re.search(chunk_id + r':"([0-9a-f]{8})"', runtime).group(1)
    tree = parse_chunk(_get('%s/assets/dist/%s.v1.%s.js' % (BASE, chunk_id, chunk_hash)))

    sectors = {}
    for sec in tree.get('children') or []:
        ko = SECTOR_KO.get(sec.get('name'))
        if not ko:
            continue
        for ind in sec.get('children') or []:
            for t in ind.get('children') or []:
                sym = (t.get('name') or '').replace('-', '.')   # BRK-B → BRK.B (네이버 표기)
                if sym:
                    sectors[sym] = [ko, ind.get('name') or '']

    path = os.path.join(OUT, 'us_sectors.json')
    if len(sectors) < MIN_COUNT:
        print('수집 실패(%d종목) → 직전 us_sectors.json 보존' % len(sectors))
        return
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'_updated': now.isoformat(timespec='seconds'), 'count': len(sectors),
                   'sectors': sectors}, f, ensure_ascii=False, separators=(',', ':'))
    ko_secs = len(set(v[0] for v in sectors.values()))
    inds = len(set(v[1] for v in sectors.values()))
    print('us_sectors.json 저장: %d종목 · 섹터 %d · 세부 산업 %d' % (len(sectors), ko_secs, inds))


if __name__ == '__main__':
    main()
