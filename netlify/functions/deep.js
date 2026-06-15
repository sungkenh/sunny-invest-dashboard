// 종목 심층분석 온디맨드 생성 — /api/deep?sym=AAPL
// 야후 quoteSummary(크럼)로 개요·투자지표, 실패 시 chart 메타로 폴백.
// 큐레이션 7종목은 정적 data/deep.json이 담당 → 이 함수는 '신규 종목' 자동 생성.
// Node 18+ 전역 fetch, 의존성 없음.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
// 워밍 인스턴스 캐시 — crumb(쿠키)·종목별 결과 재사용으로 반복 생성 지연 제거
let CRUMB = { ts: 0, cookie: '', crumb: '' };
const DCACHE = {};
const TTL = 30 * 60 * 1000;

const SECTOR_CHAIN = {
  'Technology': ['업스트림 (장비·부품·IP)', '제조·개발 (코어)', '플랫폼·제품', '다운스트림 (수요·고객)'],
  'Financial Services': ['자금·예수금', '핵심 영업 (여신·운용)', '상품·채널', '고객·시장'],
  'Healthcare': ['R&D·원료', '제조·임상', '제품·파이프라인', '의료기관·환자'],
  'Consumer Cyclical': ['원재료·부품', '제조·생산', '브랜드·제품', '유통·소비자'],
  'Consumer Defensive': ['원재료', '가공·생산', '브랜드·제품', '유통·소비자'],
  'Industrials': ['소재·부품', '제조·체계', '완성품·체계종합', '고객·수출'],
  'Energy': ['탐사·생산(업스트림)', '정제·가공(미드스트림)', '제품', '판매(다운스트림)'],
  'Communication Services': ['콘텐츠·인프라', '플랫폼·서비스', '제품·구독', '이용자·광고주'],
  'Basic Materials': ['원자재 채굴', '제련·가공', '소재·제품', '전방 산업'],
  'Utilities': ['연료·발전원', '발전·송배전', '전력·에너지', '가정·산업 수요'],
  'Real Estate': ['토지·개발', '건설·보유', '임대·운영', '임차인·시장'],
};
const DEFAULT_CHAIN = ['업스트림 (공급)', '핵심 사업', '제품·서비스', '다운스트림 (수요)'];

// 산업(industry)별 '기업 생태계' — 상위(공급·파트너)·하위(고객·전방) 실제 기업. [기업명, 역할].
// 기업명이 검색 가능하면 클릭 시 관심종목 담기. 위→아래 = 특정→일반(매칭 우선순위). (산업 리서치+검증)
const ECO_NODES = [
  [/Semiconductor Equipment|Semiconductor.*Materials/i, { up: [["램리서치","식각·증착 장비"], ["도쿄일렉트론","전공정 장비"], ["신에쓰화학","실리콘 웨이퍼·소재"], ["엔테그리스","공정 소재·필터"], ["어플라이드머티어리얼즈","전공정 장비"]], down: [["TSMC","파운드리(장비 고객)"], ["삼성전자","메모리·파운드리 고객"], ["SK하이닉스","메모리 고객"], ["인텔","IDM 고객"], ["마이크론","메모리 고객"]] }],
  [/Semiconductors/i, { up: [["ASML","EUV 노광장비"], ["어플라이드머티어리얼즈","전공정 장비"], ["TSMC","파운드리"], ["케이던스","반도체 설계 EDA"], ["Arm","CPU 코어 IP"]], down: [["애플","핵심 고객(스마트폰·PC칩)"], ["엔비디아","팹리스(설계 후 파운드리 위탁)"], ["마이크로소프트","AI 데이터센터(GPU 고객)"], ["아마존","클라우드 인프라(AWS) 자체칩 고객"], ["삼성전자","세트 제조 고객"]] }],
  [/Computer Hardware/i, { up: [["엔비디아","GPU·AI 가속기"], ["AMD","CPU·GPU"], ["인텔","서버·PC CPU"], ["TSMC","칩 파운드리"], ["삼성전자","메모리·SSD"]], down: [["마이크로소프트","클라우드(애저) 서버 고객"], ["아마존","AWS 데이터센터 고객"], ["메타","AI 인프라 고객"], ["구글","클라우드·AI 인프라 고객"], ["일반 소비자","PC·서버 최종 수요"]] }],
  [/Electronic Components/i, { up: [["무라타","MLCC·수동소자"], ["TDK","수동소자·센서"], ["삼성전기","MLCC·기판"], ["교세라","전자부품·세라믹 패키지"], ["스카이웍스","RF 부품"]], down: [["애플","스마트폰 부품 고객"], ["삼성전자","세트 제조 고객"], ["테슬라","전장 부품 고객"], ["폭스콘","EMS(위탁조립)"], ["샤오미","스마트폰 부품 고객"]] }],
  [/Consumer Electronics/i, { up: [["삼성전자","디스플레이·메모리·칩"], ["TSMC","AP 파운드리"], ["퀄컴","모바일 AP·모뎀"], ["LG디스플레이","OLED 패널"], ["폭스콘","위탁 제조(EMS)"]], down: [["베스트바이","리테일 유통"], ["아마존","온라인 유통"], ["월마트","리테일 유통"], ["코스트코","리테일 유통"], ["일반 소비자","최종 수요"]] }],
  [/Communication Equipment/i, { up: [["퀄컴","통신 칩셋·모뎀"], ["브로드컴","네트워크 칩"], ["TSMC","칩 파운드리"], ["마벨","네트워킹 반도체"], ["코닝","광섬유·케이블"]], down: [["버라이즌","통신사(5G 인프라 고객)"], ["AT&T","통신사 고객"], ["도이치텔레콤","통신사 고객"], ["T모바일","통신사 고객"], ["데이터센터 운영사","네트워크 장비 고객"]] }],
  [/Software.*Infrastructure/i, { up: [["엔비디아","AI 가속 GPU"], ["아마존 AWS","클라우드 인프라"], ["마이크로소프트 애저","클라우드 인프라"], ["오라클","데이터베이스·클라우드"], ["스노우플레이크","데이터 클라우드 플랫폼"]], down: [["엔터프라이즈 고객","SW 인프라 도입 기업"], ["세일즈포스","SaaS 사업자(인프라 SW 사용)"], ["크라우드스트라이크","보안 SaaS 사업자"], ["공공·금융기관","대규모 SW 도입처"], ["IT 개발자","개발·운영 사용자"]] }],
  [/Software.*Application/i, { up: [["마이크로소프트 애저","클라우드 호스팅"], ["아마존 AWS","클라우드 호스팅"], ["오픈AI","AI 모델 API"], ["엔비디아","AI 가속 인프라"], ["트윌리오","통신(SMS·음성) API"]], down: [["엔터프라이즈 고객","SaaS 도입 기업"], ["중소기업(SMB)","구독 사용자"], ["일반 소비자","앱 사용자"], ["애플 앱스토어","유통 채널"], ["구글 플레이","유통 채널"]] }],
  [/Internet Content|Interactive Media/i, { up: [["엔비디아","AI 가속 GPU"], ["구글 클라우드","클라우드 인프라"], ["삼성전자","서버 D램·낸드"], ["TSMC","AI 칩 파운드리"], ["네이버클라우드","데이터센터 인프라"]], down: [["광고주 기업","디지털 광고 집행"], ["일반 소비자","콘텐츠 이용자"], ["중소 광고대행사","광고 중개"], ["콘텐츠 크리에이터","플랫폼 입점 제작자"], ["이커머스 사업자","검색·광고 활용"]] }],
  [/Internet Retail/i, { up: [["아마존 AWS","클라우드 인프라"], ["페덱스","물류·배송"], ["UPS","물류·배송"], ["CJ대한통운","택배·풀필먼트"], ["엔비디아","추천·검색 AI 인프라"]], down: [["일반 소비자","온라인 구매자"], ["입점 판매자(셀러)","마켓플레이스 판매자"], ["중소 브랜드","입점 공급사"], ["광고주(스폰서드 광고)","리테일 미디어 고객"], ["물류 위탁사","풀필먼트 이용 기업"]] }],
  [/Information Technology Services|IT Services|Consulting/i, { up: [["마이크로소프트 애저","클라우드 파트너"], ["아마존 AWS","클라우드 파트너"], ["오라클","DB·ERP 공급"], ["SAP","ERP 소프트웨어"], ["엔비디아","AI 인프라"]], down: [["엔터프라이즈 고객","SI·아웃소싱 발주 기업"], ["금융기관","시스템 구축 발주처"], ["공공기관","공공 SI 발주처"], ["통신사","IT 운영 위탁"], ["제조 대기업","ERP·SI 발주처"]] }],
  [/Auto Parts/i, { up: [["TSMC","차량용 반도체 파운드리"], ["엔비디아","ADAS·인포테인먼트 칩"], ["인피니언","차량용 전력반도체"], ["삼성전자","차량용 메모리·반도체"], ["포스코홀딩스","철강·소재"]], down: [["토요타","완성차 핵심 고객"], ["폭스바겐","완성차 핵심 고객"], ["현대차","완성차 핵심 고객"], ["테슬라","완성차 핵심 고객"], ["애프터마켓 유통","보수용 부품 채널"]] }],
  [/Auto Manufacturers|Auto.*Truck|Recreational Vehicles/i, { up: [["LG에너지솔루션","EV 배터리 공급"], ["엔비디아","자율주행 컴퓨팅 플랫폼(DRIVE)"], ["보쉬","차량 핵심부품·전장 시스템"], ["TSMC","차량용 반도체 파운드리"], ["포스코홀딩스","자동차 강판·소재"]], down: [["일반 소비자","최종 구매 고객"], ["딜러 네트워크","유통·판매 채널"], ["법인·플릿 고객","대량 구매 고객"], ["렌터카 업체","렌터카 대량 구매"]] }],
  [/Electrical Equipment/i, { up: [["에코프로비엠","양극재 공급"], ["포스코퓨처엠","양극재·음극재 소재"], ["엘앤에프","양극재 공급"], ["앨버말","리튬 원료"], ["SK아이이테크놀로지","분리막 공급"]], down: [["테슬라","EV 배터리 고객"], ["GM","EV 배터리 고객"], ["현대차","EV 배터리 고객"], ["폭스바겐","EV 배터리 고객"], ["에너지저장장치(ESS) 사업자","ESS용 배터리 고객"]] }],
  [/Industrial Machinery|Specialty Industrial|Machinery|Tools & Accessories/i, { up: [["화낙","산업용 로봇·CNC 제어"], ["키엔스","센서·머신비전"], ["지멘스","자동화 제어·소프트웨어"], ["슈나이더일렉트릭","전력·자동화 부품"], ["엔비디아","산업 AI·엣지 컴퓨팅"]], down: [["테슬라","기가팩토리 생산설비 고객"], ["TSMC","반도체 제조설비 고객"], ["삼성전자","공장 자동화 설비 고객"], ["LG에너지솔루션","배터리 생산설비 고객"], ["제조업 전반","산업 자동화 수요 고객"]] }],
  [/Drug Manufacturers|Pharmaceutical/i, { up: [["론자(Lonza)","원료의약품·바이오 위탁개발생산(CDMO)"], ["삼성바이오로직스","바이오의약품 위탁생산(CDMO)"], ["우시바이오로직스(WuXi Biologics)","항체·바이오의약품 위탁개발생산(CDMO)"], ["써모피셔사이언티픽","원부자재·실험장비·바이오공정 서비스"], ["다나허(Danaher/Cytiva)","바이오공정 장비·소재"]], down: [["CVS헬스","약국·PBM 유통"], ["맥케슨(McKesson)","의약품 도매 유통"], ["카디널헬스","의약품 도매 유통"], ["유나이티드헬스(OptumRx)","PBM·보험 지급"], ["일반 소비자(환자)","최종 사용자"]] }],
  [/Biotechnology/i, { up: [["써모피셔사이언티픽","시약·실험장비"], ["다나허(Danaher/Cytiva)","바이오공정 장비·소재"], ["일루미나","유전체 시퀀싱 장비·소모품"], ["론자(Lonza)","위탁개발생산(CDMO)"], ["삼성바이오로직스","위탁생산(CDMO)"]], down: [["화이자","기술도입·인수 파트너"], ["머크(MSD)","공동개발·라이선스"], ["로슈","공동개발·인수 파트너"], ["맥케슨(McKesson)","의약품 유통"], ["일반 소비자(환자)","최종 사용자"]] }],
  [/Medical Devices|Medical Instruments|Medical Distribution/i, { up: [["TSMC","의료기기용 반도체 파운드리"], ["텍사스인스트루먼츠","센서·아날로그 반도체"], ["써모피셔사이언티픽","소재·부품·서비스"], ["애질런트","분석·계측 부품"]], down: [["HCA헬스케어","병원·의료기관 고객"], ["카디널헬스","의료기기 유통"], ["오웬스앤마이너(Owens & Minor)","의료기기·소모품 유통"], ["병원·의료기관","최종 사용 고객"], ["일반 소비자(환자)","최종 사용자"]] }],
  [/Diagnostics|Research Services/i, { up: [["일루미나","시퀀싱 장비·소모품"], ["써모피셔사이언티픽","시약·실험장비"], ["로슈","진단 시약·플랫폼"], ["애질런트","분석·계측 장비"], ["다나허(Danaher)","진단 장비·바이오공정"]], down: [["퀘스트다이아그노스틱스","임상검사 수탁기관"], ["랩코프(Labcorp)","임상검사 수탁기관"], ["병원·임상검사실","검사 수행 고객"], ["제약·바이오 R&D 고객","연구개발 수요"], ["학계·연구기관","연구 수요"]] }],
  [/Healthcare Plans/i, { up: [["화이자","처방의약품 공급사"], ["센코라(Cencora)","의약품 공급망·전문약 유통"], ["오라클(Oracle Health)","보험·청구 IT 인프라"], ["HCA헬스케어","병원 네트워크(진료 공급)"], ["카디널헬스","의약품·의료기기 공급"]], down: [["엔터프라이즈 고객(기업 단체보험)","단체보험 가입 기업"], ["일반 소비자(가입자)","개인 가입자"], ["미국 연방정부(메디케어·메디케이드)","공공보험 위탁"], ["병원·의료기관","가입자 진료 제공망"]] }],
  [/Banks/i, { up: [["FIS","코어뱅킹·결제 IT"], ["피서브","결제 처리·뱅킹 SW"], ["비자","결제 네트워크"], ["마스터카드","결제 네트워크"], ["마이크로소프트","클라우드·엔터프라이즈 SW"]], down: [["일반 소비자","리테일 예금·대출 고객"], ["엔터프라이즈 고객","기업 대출·현금관리"], ["중소기업(SME)","사업자 금융 고객"], ["부동산·건설 차주","상업용 부동산 대출"], ["기관·정부 고객","공공·기관 예치"]] }],
  [/Insurance/i, { up: [["뮌헨리","재보험"], ["스위스리","재보험"], ["블랙록","자산운용·운용위탁"], ["가이드와이어","보험 코어 SW"], ["베리스크애널리틱스","리스크 데이터·분석"]], down: [["일반 소비자","개인 보험 가입자"], ["자동차 보유자","자동차 보험 고객"], ["주택 보유자","주택·재산 보험 고객"], ["보험 브로커·대리점","유통 채널"], ["엔터프라이즈 고객","기업·단체 보험"]] }],
  [/Capital Markets|Financial Data/i, { up: [["블룸버그","단말·시장데이터"], ["S&P글로벌","신용평가·데이터"], ["MSCI","지수·분석"], ["ICE","거래소·데이터"], ["나스닥","거래소·트레이딩 인프라"]], down: [["블랙록","기관 트레이딩·발행 고객"], ["기관투자자","트레이딩·자산배분"], ["헤지펀드·자산운용사","트레이딩·리서치 고객"], ["상장 기업","발행·IR 고객"], ["개인투자자","리테일 브로커리지"]] }],
  [/Asset Management/i, { up: [["블룸버그","시장데이터·단말"], ["MSCI","지수·벤치마크"], ["S&P글로벌","지수·신용데이터"], ["스테이트스트리트","수탁·관리(커스터디)"], ["블랙록(알라딘)","포트폴리오·리스크 플랫폼"]], down: [["기관투자자","위탁운용 고객"], ["연금기금·국부펀드","대형 위탁운용"], ["퇴직연금 가입자","개인연금·DC 가입자"], ["투자자문·증권사 채널","유통 채널"], ["일반 소비자","리테일 펀드·ETF 투자자"]] }],
  [/Credit Services/i, { up: [["비자","결제 네트워크"], ["마스터카드","결제 네트워크"], ["피서브","결제 처리·이슈잉"], ["FICO","신용평가 모델"], ["에퀴팩스","신용정보·데이터"]], down: [["일반 소비자","카드·소비자금융 이용자"], ["가맹점(머천트)","결제 수용 가맹"], ["아마존","코브랜드 카드·결제 가맹"], ["월마트","리테일 가맹·코브랜드 카드"], ["중소상공인","사업자 결제 가맹"]] }],
  [/Oil & Gas Integrated|Oil & Gas Refining/i, { up: [["슐럼버거","유전 서비스"], ["핼리버튼","시추·완결 서비스"], ["베이커휴즈","유전 장비·LNG 설비"], ["테크닙에너지스","EPC 플랜트"]], down: [["델타항공","항공유 고객"], ["다우","석유화학 원료 고객"], ["발레로에너지","정제·유통 고객"], ["산업·운송 고객","연료 수요"]] }],
  [/Oil & Gas E&P|Oil & Gas Drilling|Oil & Gas Midstream|Oil & Gas Equipment/i, { up: [["슐럼버거","유전 서비스"], ["핼리버튼","시추·수압파쇄"], ["베이커휴즈","시추 장비"], ["엔비디아","지진탐사 컴퓨팅"], ["NOV","시추 장비"]], down: [["엑슨모빌","정제·통합 고객"], ["발레로에너지","정유사 고객"], ["필립스66","정유·미드스트림 고객"], ["킨더모건","파이프라인 운송 고객"], ["셰니어에너지","LNG 수출 고객"]] }],
  [/Utilities/i, { up: [["GE버노바","터빈·발전 장비"], ["지멘스에너지","발전·송배전 장비"], ["퍼스트솔라","태양광 모듈"], ["베스타스","풍력 터빈"], ["엑슨모빌","천연가스 연료 공급"]], down: [["아마존","데이터센터 전력 수요"], ["마이크로소프트","데이터센터 전력 수요"], ["일반 소비자","주택용 전력"], ["산업·제조 고객","산업용 전력"]] }],
  [/Steel/i, { up: [["발레","철광석 공급"], ["BHP그룹","철광석·원료탄"], ["리오틴토","철광석 공급"], ["린데","산업용 가스"]], down: [["현대자동차","자동차 강판 고객"], ["HD현대중공업","조선용 후판 고객"], ["기아","자동차 강판 고객"], ["캐터필러","중장비 제조 고객"], ["건설사 전반","건설용 형강·철근"]] }],
  [/Chemicals/i, { up: [["엑슨모빌","나프타·석유화학 원료"], ["다우","기초화학 원료"], ["BASF","기초화학 원료"], ["린데","산업용 가스"], ["에어프로덕츠","산업용 가스"]], down: [["삼성전자","반도체·전자소재 고객"], ["TSMC","반도체 소재 고객"], ["프록터앤드갬블","소비재 제조 고객"], ["현대자동차","코팅·소재 고객"], ["제조업 전반","산업용 첨가제"]] }],
  [/Aerospace|Defense/i, { up: [["GE에어로스페이스","항공기 엔진"], ["RTX","엔진·미사일·항전"], ["하니웰","항전·부품"], ["트랜스다임","항공 부품"], ["하우멧에어로스페이스","엔진 정밀부품·소재"]], down: [["미국 국방부","핵심 고객"], ["델타항공","민항기 고객"], ["유나이티드항공","민항기 고객"], ["아메리칸항공","민항기 고객"], ["동맹국 정부","FMS 무기 수출 고객"]] }],
  [/Specialty Retail|Apparel Retail|Department Stores|Footwear|Luxury|Discount Stores|Home Improvement/i, { up: [["나이키","주요 공급 브랜드(의류·신발)"], ["애플","기기·액세서리 공급"], ["삼성전자","전자제품 공급"], ["오라클","리테일 ERP·POS(MICROS) 소프트웨어"], ["UPS","물류·배송 파트너"]], down: [["일반 소비자","최종 구매자"], ["아마존","온라인 마켓플레이스 경쟁·채널"], ["메이시스","백화점 유통 경쟁사"]] }],
  [/Restaurants/i, { up: [["시스코(Sysco)","북미 최대 식자재 유통"], ["타이슨푸드","육류·단백질 공급"], ["코카콜라","음료 공급"], ["펩시코","음료·스낵 공급"], ["도어대시","배달 플랫폼 파트너"]], down: [["일반 소비자","최종 고객"], ["우버이츠","배달 채널 고객 유입"]] }],
  [/Beverages/i, { up: [["볼코퍼레이션(Ball Corp)","알루미늄 캔 공급"], ["크라운홀딩스","캔·금속 패키징 공급"], ["아처대니얼스미들랜드(ADM)","감미료·원료 공급"], ["인터내셔널플레이버스앤드프래그런스(IFF)","향료·원료 공급"]], down: [["월마트","대형 유통 채널"], ["코스트코","창고형 유통 채널"], ["맥도날드","외식 채널 대형 고객"], ["일반 소비자","최종 소비자"]] }],
  [/Packaged Foods|Confectioners|Food Distribution|Farm Products/i, { up: [["아처대니얼스미들랜드(ADM)","곡물·원료 공급"], ["벙기(Bunge)","식용유·원료 공급"], ["타이슨푸드","육류 원료 공급"], ["인터내셔널플레이버스앤드프래그런스(IFF)","향료·첨가물 공급"], ["인터내셔널페이퍼","종이 패키징 공급"]], down: [["월마트","최대 유통 채널"], ["코스트코","창고형 유통 채널"], ["크로거","식료품 유통 채널"], ["아마존","온라인 유통 채널"]] }],
  [/Telecom/i, { up: [["에릭슨","5G 네트워크 장비"], ["노키아","네트워크 장비"], ["삼성전자","네트워크 장비·단말 공급"], ["애플","단말기(아이폰) 공급"], ["시스코(Cisco)","네트워크 인프라 장비"]], down: [["일반 소비자","개인 가입자"], ["엔터프라이즈 고객","기업 회선·전용망"], ["넷플릭스","대역폭 소비·트래픽 유발 사업자"]] }],
  [/Gaming|Electronic Gaming/i, { up: [["엔비디아","GPU·그래픽 기술"], ["AMD","콘솔용 반도체·GPU(PS5·Xbox)"], ["에픽게임즈","언리얼엔진 게임 엔진"], ["유니티소프트웨어","게임 엔진"], ["아마존","AWS 클라우드 인프라"]], down: [["소니","플레이스테이션 플랫폼·배급"], ["마이크로소프트","엑스박스 플랫폼·배급"], ["닌텐도","콘솔 플랫폼"], ["일반 소비자","게이머"]] }],
  [/Entertainment|Media|Broadcasting|Advertising/i, { up: [["엔비디아","렌더링·AI GPU 인프라"], ["아마존","AWS 클라우드·스트리밍 인프라"], ["돌비래버러토리스","오디오·영상 기술 라이선스"]], down: [["일반 소비자","최종 시청자"], ["컴캐스트","케이블·배급 채널"], ["AMC엔터테인먼트","극장 상영 채널"]] }],
  [/Airlines|Airport/i, { up: [["보잉","항공기 제조"], ["에어버스","항공기 제조"], ["GE에어로스페이스","항공기 엔진"], ["RTX(프랫앤휘트니)","항공기 엔진"], ["엑손모빌","항공유 공급"]], down: [["일반 소비자","항공 여객"], ["엔터프라이즈 고객","기업 출장·화물"], ["익스피디아","여행 예약 유통 채널"]] }],
];
// 산업 미상 시 섹터별 폴백(일반 유형)
const SECTOR_ECO = {
  'Technology': { up: [['반도체·클라우드 인프라', ''], ['부품·장비·IP', '']], down: [['기업 고객', ''], ['일반 소비자', '']] },
  'Healthcare': { up: [['원료·CDMO·장비', ''], ['R&D·임상', '']], down: [['병원·약국', ''], ['환자·보험', '']] },
  'Financial Services': { up: [['자본·결제·IT 인프라', '']], down: [['기업 고객', ''], ['개인 고객', '']] },
  'Consumer Cyclical': { up: [['부품·소재·브랜드', ''], ['물류', '']], down: [['유통 채널', ''], ['일반 소비자', '']] },
  'Consumer Defensive': { up: [['원재료·포장', '']], down: [['대형 유통', ''], ['일반 소비자', '']] },
  'Industrials': { up: [['소재·부품·자동화', '']], down: [['제조·인프라 고객', ''], ['수출', '']] },
  'Energy': { up: [['시추·장비·서비스', '']], down: [['정유·발전', ''], ['산업·운송', '']] },
  'Communication Services': { up: [['장비·콘텐츠·인프라', '']], down: [['가입자·이용자', ''], ['광고주', '']] },
  'Basic Materials': { up: [['원자재·광석·가스', '']], down: [['제조·건설 전방산업', '']] },
  'Utilities': { up: [['발전설비·연료', '']], down: [['데이터센터·산업', ''], ['가정 수요', '']] },
  'Real Estate': { up: [['건설·개발·자본', '']], down: [['임차인·입주사', '']] },
};
function ecoNodes(sector, industry) {
  const ind = industry || '';
  for (const [re, n] of ECO_NODES) if (re.test(ind)) return n;
  return SECTOR_ECO[sector] || { up: [['공급·파트너 기업', '']], down: [['고객·전방 기업', '']] };
}
// 기업 생태계 3단: 상위(공급) · 본 기업+관련 · 하위(고객). nodes=[기업명, 역할].
function buildChain(sector, industry, name, peers) {
  const e = ecoNodes(sector, industry);
  const mid = [[name, industry || sector || '핵심 사업']].concat((peers || []).slice(0, 3).map((p) => [p[0], '관련 종목']));
  return [
    { h: '상위 기업 (공급·파트너)', nodes: e.up },
    { h: '본 기업 · 관련 기업', nodes: mid },
    { h: '하위 기업 (고객·전방)', nodes: e.down },
  ];
}

const baseSym = (s) => (s || '').replace('.KS', '').replace('.KQ', '');
const isKR = (s) => s.endsWith('.KS') || s.endsWith('.KQ');
const raw = (o) => (o && typeof o === 'object' && 'raw' in o) ? o.raw : (typeof o === 'number' ? o : null);

function trim(x) {
  if (x >= 100) return Math.round(x).toLocaleString('en-US');
  if (x >= 10) return x.toFixed(1);
  return x.toFixed(2);
}
function fmtMcap(v, kr) {
  if (!v) return '-';
  if (kr) { if (v >= 1e12) return trim(v / 1e12) + '조'; if (v >= 1e8) return trim(v / 1e8) + '억'; return Math.round(v).toLocaleString(); }
  if (v >= 1e12) return '$' + trim(v / 1e12) + 'T';
  if (v >= 1e9) return '$' + trim(v / 1e9) + 'B';
  if (v >= 1e6) return '$' + trim(v / 1e6) + 'M';
  return '$' + trim(v);
}
function fmtPx(v, kr) { if (v == null) return '-'; return kr ? Math.round(v).toLocaleString() : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function num(x, suf = '', mul = 1, dec = 1) { if (x == null || isNaN(x)) return '-'; return (x * mul).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf; }
function rangePos(p, lo, hi) { if (p == null || lo == null || hi == null || hi <= lo) return null; return Math.max(0, Math.min(100, Math.round((p - lo) / (hi - lo) * 100))); }
function perNote(p) { if (p == null) return ''; if (p < 0) return '적자(N/A)'; if (p < 12) return '저평가 구간'; if (p < 25) return '시장 평균권'; if (p < 45) return '성장 프리미엄'; return '고평가 구간'; }
function pbrNote(p) { if (p == null) return ''; if (p < 1) return '순자산 이하'; if (p < 2) return '낮은 편'; if (p < 5) return '보통'; return '높은 편'; }

async function translate(text) {
  if (!text) return '';
  try {
    let s = text.trim().slice(0, 600);
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=' + encodeURIComponent(s);
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    return (d[0] || []).map((seg) => seg[0]).filter(Boolean).join('');
  } catch (e) { return text; }
}

async function getCrumb() {
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
    let cookie = '';
    const sc = r1.headers.get('set-cookie');
    if (sc) cookie = sc.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': cookie } });
    const crumb = (await r2.text()).trim();
    if (crumb && !crumb.includes('<')) return { cookie, crumb };
  } catch (e) { /* fall through */ }
  return null;
}
// crumb 캐시(30분) — getCrumb의 2회 순차 요청(≈700ms)을 매 호출마다 반복하지 않음
async function getCrumbCached() {
  if (CRUMB.crumb && Date.now() - CRUMB.ts < TTL) return { cookie: CRUMB.cookie, crumb: CRUMB.crumb };
  const c = await getCrumb();
  if (c && c.crumb) { CRUMB = { ts: Date.now(), cookie: c.cookie, crumb: c.crumb }; return c; }
  return CRUMB.crumb ? { cookie: CRUMB.cookie, crumb: CRUMB.crumb } : null;   // 만료 시 직전값 폴백
}
// 연관(추천 유사) 종목 — 독립 호출이라 병렬 실행
async function fetchRecs(sym) {
  try {
    const u = 'https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/' + encodeURIComponent(sym);
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    return (((d.finance || {}).result || [{}])[0].recommendedSymbols || []).map((x) => [x.symbol, '']).filter((a) => a[0]).slice(0, 6);
  } catch (e) { return []; }
}

async function quoteSummary(sym, cr) {
  const mods = 'assetProfile,summaryDetail,financialData,defaultKeyStatistics,price';
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const h of hosts) {
    try {
      const u = `https://${h}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}` +
        (cr ? `&crumb=${encodeURIComponent(cr.crumb)}` : '');
      const r = await fetch(u, { headers: { 'User-Agent': UA, ...(cr ? { 'Cookie': cr.cookie } : {}) } });
      if (!r.ok) continue;
      const d = await r.json();
      const res = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
      if (res) return res;
    } catch (e) { /* try next host */ }
  }
  return null;
}

async function chartMeta(sym) {
  try {
    const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=1d';
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    return d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  } catch (e) { return null; }
}

exports.handler = async (event) => {
  const qp = event.queryStringParameters || {};
  const sym = (qp.sym || '').trim();
  if (!sym) return resp({ error: 'no sym' });
  const fresh = qp.fresh != null;   // 사용자 새로고침 → 캐시 우회
  const ck = sym.toUpperCase();
  if (!fresh && DCACHE[ck] && Date.now() - DCACHE[ck].ts < TTL) return resp(DCACHE[ck].data);   // 워밍 캐시 즉시 반환

  const kr = isKR(sym);
  const ASOF = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const recsP = fetchRecs(sym);                 // 연관종목 병렬 시작(독립)
  const cr = await getCrumbCached();             // crumb 캐시(첫 호출만 ≈700ms)
  const qs = await quoteSummary(sym, cr);
  const meta = qs ? null : await chartMeta(sym);

  const sd = (qs && qs.summaryDetail) || {};
  const fd = (qs && qs.financialData) || {};
  const ks = (qs && qs.defaultKeyStatistics) || {};
  const ap = (qs && qs.assetProfile) || {};
  const pr = (qs && qs.price) || {};

  const px = raw(fd.currentPrice) || raw(pr.regularMarketPrice) || (meta && meta.regularMarketPrice) || null;
  const pc = raw(pr.regularMarketPreviousClose) || raw(sd.previousClose) || (meta && meta.chartPreviousClose) || null;
  const pct = (px && pc) ? Math.round((px - pc) / pc * 10000) / 100 : 0;

  const sector = ap.sector || '';
  const industry = ap.industry || '';
  const name = pr.longName || pr.shortName || (meta && (meta.longName || meta.shortName)) || baseSym(sym);

  // PER(후행→선행), PBR(없으면 가격/주당순자산), 배당(%)
  let per = raw(sd.trailingPE), perFwd = false;
  if (per == null && raw(ks.forwardPE) != null) { per = raw(ks.forwardPE); perFwd = true; }
  let pbr = raw(ks.priceToBook) || raw(sd.priceToBook);
  if (pbr == null) { const bv = raw(ks.bookValue); if (bv && px) pbr = px / bv; }
  let eps = raw(ks.trailingEps), epsFwd = false;                          // 주당순이익(EPS)
  if (eps == null && raw(ks.forwardEps) != null) { eps = raw(ks.forwardEps); epsFwd = true; }
  if (eps == null && per && px) eps = px / per;                           // 폴백: 주가 ÷ PER
  const mcap = raw(sd.marketCap) || raw(pr.marketCap);
  const roe = raw(fd.returnOnEquity);
  const rg = raw(fd.revenueGrowth);
  const opm = raw(fd.operatingMargins) != null ? raw(fd.operatingMargins) : raw(fd.profitMargins);
  let divPct = null;
  const dRate = raw(sd.dividendRate) || raw(sd.trailingAnnualDividendRate);
  if (dRate && px) divPct = dRate / px * 100;
  else if (raw(sd.dividendYield) != null) divPct = raw(sd.dividendYield) * 100;
  else if (raw(sd.trailingAnnualDividendYield) != null) divPct = raw(sd.trailingAnnualDividendYield) * 100;
  const tgt = raw(fd.targetMeanPrice);
  const lo = raw(sd.fiftyTwoWeekLow) || (meta && meta.fiftyTwoWeekLow);
  const hi = raw(sd.fiftyTwoWeekHigh) || (meta && meta.fiftyTwoWeekHigh);
  const pos = rangePos(px, lo, hi);

  const metrics = [
    { k: '시가총액', v: fmtMcap(mcap, kr), x: sector },
    { k: perFwd ? 'PER (Fwd)' : 'PER (TTM)', v: num(per, '', 1, 1), x: perNote(per) },
    { k: epsFwd ? 'EPS (Fwd)' : 'EPS (TTM)', v: eps != null ? fmtPx(eps, kr) : '-', x: '주당순이익' },
    { k: 'PBR', v: num(pbr, '', 1, 2), x: pbrNote(pbr) },
    { k: 'ROE', v: num(roe, '%', 100), x: '자기자본이익률' },
    { k: '매출성장(YoY)', v: num(rg, '%', 100), x: '연간 매출 증가율' },
    { k: '영업이익률', v: num(opm, '%', 100), x: '수익성' },
    { k: '배당수익률', v: num(divPct, '%', 1, 2), x: '연환산' },
    { k: '컨센서스 목표가', v: tgt ? fmtPx(tgt, kr) : '-', x: (tgt && px) ? ('상승여력 ' + (((tgt - px) / px * 100 >= 0 ? '+' : '') + ((tgt - px) / px * 100).toFixed(1)) + '%') : '' },
  ];
  if (pos != null) metrics.push({ k: '52주 위치', v: pos + '%', x: '저점' + fmtPx(lo, kr) + ' ~ 고점' + fmtPx(hi, kr), bar: pos });

  // 개요
  let overview;
  if (ap.longBusinessSummary) {
    let ko = await translate(ap.longBusinessSummary);
    const parts = ko.replace(/。/g, '.').split('. ').slice(0, 2).join('. ').trim();
    overview = parts + (parts.endsWith('.') ? '' : '.');
    if (sector) overview += ' (업종: ' + sector + (industry ? ' · ' + industry : '') + ')';
  } else {
    overview = sector ? ('업종: ' + sector + (industry ? ' · ' + industry : '')) : '회사 개요 데이터가 아직 수집되지 않았습니다.';
  }

  // 연관종목(추천 유사종목) — 위에서 병렬로 시작한 결과 수거(밸류체인·연관종목 공용)
  const recs = await recsP;

  // 밸류체인 — 산업별 구체 노드 + 실제 동종/경쟁 종목 주입
  const chain = buildChain(sector, industry, name, recs);

  let rel = {};
  if (recs && recs.length) rel['유사·연관 종목'] = recs;
  if (sector) rel['동일 섹터'] = [[sector, '']];
  if (!Object.keys(rel).length) rel = { '연관 종목': [['데이터 수집 중', '']] };

  // 전문가 리포트(데이터 기반 자동)
  const bull = [], bear = [];
  if (per != null && per < 15) bull.push('밸류에이션 매력(PER ' + per.toFixed(1) + ')');
  if (pos != null && pos < 35) bull.push('52주 저점권(현 위치 ' + pos + '%) — 낙폭 과대 가능');
  if (pos != null && pos > 75) bear.push('52주 고점권(현 위치 ' + pos + '%) — 단기 과열 주의');
  if (per != null && per > 45) bear.push('높은 밸류에이션(PER ' + per.toFixed(1) + ') — 실적 민감');
  if (pbr != null && pbr > 6) bear.push('PBR ' + pbr.toFixed(1) + ' 고평가 구간');
  if (!bull.length) bull.push('실적·모멘텀 데이터 보강 중');
  if (!bear.length) bear.push('거시·수급 변동성 모니터링');
  const rep = {
    op: 'op-hold', opTxt: '분석 보강중', desk: '리서치 데스크', asof: ASOF,
    thesis: name + '은(는) ' + (sector || '해당') + ' 섹터 종목으로 현재 밸류에이션은 ' + (perNote(per) || '평가 중') +
      ' 수준입니다. 핵심 정성 분석(밸류체인·투자논거)은 리서치 데스크가 순차 보강하며, 투자지표·개요는 실시간 데이터로 자동 생성됩니다.',
    bull, bear,
    cat: ['분기 실적 발표', '섹터 업황·정책 이벤트'],
    risk: '자동 생성 리포트 — 정성 분석 보강 전까지는 참고용. 분할·소액 접근 권장.',
  };

  const data = {
    name, mk: kr ? 'KR' : 'US', sym,
    px: px || 0, pct, asof: ASOF, curated: false,
    overview, metrics, chain, rel, rep,
  };
  DCACHE[ck] = { ts: Date.now(), data };
  return resp(data);
};

function resp(obj) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // 생성 결과를 CDN 엣지에 캐시(30분) → 같은 종목 재요청은 즉시(첫 사용자만 생성)
      'Cache-Control': 'public, max-age=300',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
    },
    body: JSON.stringify(obj),
  };
}
