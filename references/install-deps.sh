# Environment setup commands
#
# These are NOT meant to be pasted as one shell script into Sprites:exec —
# that tool does not go through a shell (no &&, no pipes, no quoting).
# Run each logical step as its own Sprites:exec call, OR wrap the whole
# thing in Sprites:service_create with cmd="bash", args=["-c", "<all of this joined with && >"]
# if you want it as one shell-interpreted unit.
#
# Tested working sequence on a fresh Ubuntu (questing) sprite:

# 1. System packages: virtual display, VNC server, noVNC web client, websocket proxy
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb x11vnc novnc websockify curl

# 2. Node project + Playwright
mkdir -p /home/sprite/pw
cd /home/sprite/pw && npm init -y
cd /home/sprite/pw && npm install playwright

# 3. Real Google Chrome (NOT the bundled Chromium — meaningfully less likely to be
#    flagged as automated by sites' bot-detection JS)
cd /home/sprite/pw && npx playwright install chrome

# 4. System libs Chrome needs to actually render (fonts, nss, gtk, etc).
#    `sudo` on Sprites has a minimal PATH, so pass it explicitly for npx to be found.
cd /home/sprite/pw && sudo env PATH=/home/sprite/.local/bin:/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx playwright install-deps chromium

# 5. X11 socket dir — Xvfb refuses to start without this existing with the right perms
sudo mkdir -p /tmp/.X11-unix
sudo chmod 1777 /tmp/.X11-unix

# --- After this, create the three display/VNC services via Sprites:service_create ---
# (see SKILL.md step 3 for exact args — summarized here for reference)
#
# service_name=xvfb    cmd=Xvfb   args=[":99","-screen","0","1280x800x24","-nolisten","tcp"]
#                       needs=[]
#
# service_name=x11vnc  cmd=x11vnc args=["-display",":99","-nopw","-listen","0.0.0.0","-xkb",
#                                        "-forever","-shared","-rfbport","5900"]
#                       needs=["xvfb"]
#
# service_name=novnc   cmd=websockify args=["--web","/usr/share/novnc","6080","localhost:5900"]
#                       needs=["x11vnc"]   http_port=6080   <- this exposes it on the sprite's URL
#
# noVNC is then reachable at:
#   https://<sprite-name>-<id>.sprites.app/vnc.html?autoconnect=true&resize=scale
