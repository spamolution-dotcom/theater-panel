import subprocess, sys, os, time
from playwright.sync_api import sync_playwright
FPS=25; d=os.getcwd(); out=sys.argv[1] if len(sys.argv)>1 else 'card'
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1920,'height':1080})
    pg.goto(f'file://{d}/card.html'); pg.evaluate('window.ready')
    T=pg.evaluate('window.TIMELINE')
    def seg(name,a,z):
        ff=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','image2pipe','-framerate',str(FPS),'-c:v','mjpeg','-i','-','-c:v','libx264','-preset','medium','-crf','25','-pix_fmt','yuv420p','-profile:v','high','-level','4.1','-g','50',name],stdin=subprocess.PIPE)
        n=round((z-a)*FPS); t0=time.time()
        for i in range(n):
            pg.evaluate(f'render({a+i/FPS})')
            ff.stdin.write(pg.screenshot(type='jpeg',quality=92))
        ff.stdin.close(); ff.wait(); print(name,n,'frames',round(time.time()-t0),'s',flush=True)
    seg(f'{out}_main.mp4',0,T['loopStart'])
    pg.evaluate(f"render({T['loopStart']})"); pg.screenshot(path=f'{out}_still.png')
    b.close()
