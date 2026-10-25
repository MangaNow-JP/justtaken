"""Small, deterministic TIFF/DNG sensor fixtures; these are NOT Apple ProRAW captures."""
from pathlib import Path
import struct,json
folder=Path(__file__).resolve().parent.parent/'workers/api/test/fixtures'
for linear in [False,True]:
    name='linear-dng' if linear else 'bayer-dng'
    w,h,samples=512,384,3 if linear else 1
    entries={}
    def tag(t,typ,values):
        values=values if isinstance(values,(list,bytes)) else [values]
        if typ in (1,2,7): data=bytes(values);count=len(data)
        else: data=b''.join(struct.pack('<'+{3:'H',4:'I',5:'II',10:'ii'}[typ],*(v if isinstance(v,tuple) else (v,))) for v in values);count=len(values)
        entries[t]=(typ,count,data)
    tag(254,4,0);tag(271,2,b'JustTaken\0');tag(272,2,b'Synthetic sensor\0');tag(256,4,w);tag(257,4,h);tag(258,3,[16]*samples);tag(259,3,1);tag(262,3,34892 if linear else 32803)
    tag(273,4,0);tag(274,3,6);tag(277,3,samples);tag(278,4,h);tag(279,4,w*h*samples*2);tag(284,3,1)
    tag(50706,1,bytes([1,4,0,0]));tag(50707,1,bytes([1,1,0,0]));tag(50708,2,b'JustTaken synthetic sensor\0')
    tag(50714,5,[(0,1)]);tag(50717,4,65535 if linear else 4095);tag(50718,5,[(1,1),(1,1)]);tag(50719,4,[0,0]);tag(50720,4,[w,h])
    tag(50721,10,[(1 if i in [0,4,8] else 0,1) for i in range(9)]);tag(50728,5,[(1,1)]*3);tag(50778,3,21)
    if not linear:
        tag(33421,3,[2,2]);tag(33422,1,bytes([0,1,1,2]));tag(50710,1,bytes([0,1,2]));tag(50711,3,1)
    start=8+2+len(entries)*12+4
    extra=bytearray();directory=bytearray()
    for t,(typ,count,data) in sorted(entries.items()):
        offset=start+len(extra)
        directory+=struct.pack('<HHI',t,typ,count)+(data.ljust(4,b'\0') if len(data)<=4 else struct.pack('<I',offset))
        if len(data)>4:
            extra+=data
            if len(extra)%2:extra+=bytes(1)
    pixels=start+len(extra)
    n=sorted(entries).index(273);directory[n*12+8:n*12+12]=struct.pack('<I',pixels)
    payload=bytearray()
    for y in range(h):
        for x in range(w):
            for c in range(samples):payload+=struct.pack('<H',int((65535 if linear else 4095)*((x+y+c*47)%512)/511))
    data=b'II'+struct.pack('<HIH',42,8,len(entries))+directory+bytes(4)+extra+payload
    (folder/(name+'.dng')).write_bytes(data)
    (folder/(name+'.json')).write_text(json.dumps(dict(id='original',role='original',mime='image/x-adobe-dng',width=w,height=h,orientation=6,preservation='camera-original',hasGainMap=False,bytes=len(data)),indent=2))
    print(name,len(data))
