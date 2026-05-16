from flask import Flask, render_template, request, jsonify, Response, stream_with_context
import requests
import os
import sys
import logging
import json
import yt_dlp
import threading
import time
import uuid
import random
import shutil
from datetime import datetime, timedelta, timezone

# Cấu hình logging
logging.basicConfig(level=logging.ERROR, stream=sys.stdout)
logger = logging.getLogger(__name__)

app = Flask(__name__)

SUPERVISOR_TOKEN = os.getenv('SUPERVISOR_TOKEN', '')
HA_URL = "http://supervisor/core/api"
DATA_DIR = "/data" 
PLAYLIST_FILE = os.path.join(DATA_DIR, "playlists_v11.json")
TIMERS_FILE = os.path.join(DATA_DIR, "timers_v11.json")
QUEUE_FILE = os.path.join(DATA_DIR, "queue_v12013.json")
SLEEP_TIMER_FILE = os.path.join(DATA_DIR, "sleep_timer_v12013.json")
RECENT_HISTORY_FILE = os.path.join(DATA_DIR, "recent_history_v12014.json")
PRESETS_FILE = os.path.join(DATA_DIR, "presets_v12014.json")
SCHEDULE_RULES_FILE = os.path.join(DATA_DIR, "schedule_rules_v12016.json")

if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

# --- Quản lý dữ liệu ---
def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except: return default
    return default

def save_json(path, data):
    # Atomic save + backup .bak to reduce corruption risk
    tmp_path = path + '.tmp'
    bak_path = path + '.bak'
    try:
        if os.path.exists(path):
            try:
                shutil.copy2(path, bak_path)
            except Exception:
                pass
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception as e:
        logger.error(f"save_json error for {path}: {e}")
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass

playlists = load_json(PLAYLIST_FILE, {})
timers = load_json(TIMERS_FILE, [])
queue = load_json(QUEUE_FILE, [])
sleep_timer = load_json(SLEEP_TIMER_FILE, {"enabled": False, "end_at": None, "entity_id": None, "minutes": 0})
recent_history = load_json(RECENT_HISTORY_FILE, [])
presets = load_json(PRESETS_FILE, [])
schedule_rules = load_json(SCHEDULE_RULES_FILE, [])
state_lock = threading.RLock()
last_ytdlp_error = None
last_timer_run = None
APP_VERSION = "1.20.17"
APP_START_TIME = time.time()
watchdog_enabled = True

# --- v1.20.12 Debug/Test/Health helpers ---
LOG_FILE = os.path.join(DATA_DIR, "logs_v12011.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings_v12011.json")
TEST_HISTORY_FILE = os.path.join(DATA_DIR, "test_history_v12011.json")
SELF_CHECK_FILE = os.path.join(DATA_DIR, "self_check_v12012.json")
CAST_RETRY_MAX = 2
CAST_RETRY_DELAY = 1.5

def _now_iso():
    return datetime.now().isoformat(timespec='seconds')

def _safe_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default

def _next_run_for_rule(rule, from_dt=None):
    """Return next run datetime for a schedule rule, or None if invalid."""
    base = from_dt or datetime.now()
    at = str(rule.get('at') or '').strip()
    if not at or ':' not in at:
        return None
    try:
        hh, mm = at.split(':', 1)
        hh = int(hh)
        mm = int(mm)
        if hh < 0 or hh > 23 or mm < 0 or mm > 59:
            return None
    except Exception:
        return None
    days = rule.get('days') or []
    days = [d for d in days if isinstance(d, int) and 0 <= d <= 6]
    for offset_day in range(0, 8):
        cand_day = base.date() + timedelta(days=offset_day)
        cand_dt = datetime.combine(cand_day, datetime.min.time()).replace(hour=hh, minute=mm, second=0, microsecond=0)
        if days and cand_dt.weekday() not in days:
            continue
        if cand_dt >= base:
            return cand_dt
    return None

def _play_rule_now(rule):
    pl_name = rule.get('playlist_name')
    eid = rule.get('entity_id')
    if pl_name not in playlists or not playlists.get(pl_name):
        raise RuntimeError('playlist not found or empty')
    song = random.choice(playlists[pl_name]) if rule.get('is_random', True) else playlists[pl_name][0]
    info = resolve_youtube_stream(song.get('url'), 'audio', eid, 'auto')
    with state_lock:
        active_session.update({
            "entity_id": eid,
            "url": info.get('url'),
            "source_url": song.get('url'),
            "title": song.get('title'),
            "thumbnail": song.get('thumbnail'),
            "mode": "audio",
            "resolution": "auto",
            "should_be_playing": True,
            "last_position": 0,
            "retry_count": 0,
            "last_retry_at": 0,
            "last_error": None
        })
    call_ha_service("media_player", "play_media", {
        "entity_id": eid,
        "media_content_id": info.get('url'),
        "media_content_type": "audio/mp4",
        "extra": {
            "title": song.get('title'),
            "thumb": song.get('thumbnail')
        }
    }, timeout=10)
    return {"entity_id": eid, "playlist_name": pl_name, "title": song.get('title')}

def mask_secret_value(v):
    if v is None:
        return None
    if not isinstance(v, str):
        return v
    if len(v) <= 8:
        return "***"
    return v[:3] + "***" + v[-3:]

def mask_obj(obj):
    secret_words = ['token', 'secret', 'password', 'authorization', 'api_key', 'apikey', 'key']
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if any(w in str(k).lower() for w in secret_words):
                out[k] = mask_secret_value(v)
            else:
                out[k] = mask_obj(v)
        return out
    if isinstance(obj, list):
        return [mask_obj(x) for x in obj]
    return obj

def add_log(level, message, meta=None):
    try:
        rows = load_json(LOG_FILE, [])
        rows.append({"time": _now_iso(), "level": level, "message": message, "meta": mask_obj(meta or {})})
        rows = rows[-300:]
        save_json(LOG_FILE, rows)
    except Exception as e:
        logger.error(f"add_log error: {e}")

def get_settings():
    defaults = {"provider": "youtube", "model": "yt-dlp-default"}
    data = load_json(SETTINGS_FILE, defaults)
    if not isinstance(data, dict):
        data = defaults
    for k, v in defaults.items():
        data.setdefault(k, v)
    return data

def set_settings(data):
    cur = get_settings()
    provider = (data.get('provider') or cur.get('provider') or 'youtube').strip()[:80]
    model = (data.get('model') or cur.get('model') or 'yt-dlp-default').strip()[:120]
    cur.update({"provider": provider, "model": model, "updated_at": _now_iso()})
    save_json(SETTINGS_FILE, cur)
    add_log('info', 'Settings updated', cur)
    return cur

def ha_headers():
    return {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}

def call_ha_service(domain, service, payload, timeout=10, retries=CAST_RETRY_MAX):
    """Call Home Assistant service with a small soft-retry window."""
    url = f"{HA_URL}/services/{domain}/{service}"
    last_error = None
    for attempt in range(retries + 1):
        try:
            r = requests.post(url, headers=ha_headers(), json=payload, timeout=timeout)
            if 200 <= r.status_code < 300:
                if attempt > 0:
                    add_log('warn', 'HA service recovered after retry', {"service": service, "attempt": attempt + 1})
                return r
            last_error = f"HTTP {r.status_code}: {r.text[:180]}"
        except Exception as e:
            last_error = str(e)
        if attempt < retries:
            add_log('warn', 'Retrying HA service call', {"service": service, "attempt": attempt + 1, "error": last_error})
            time.sleep(CAST_RETRY_DELAY * (attempt + 1))
    add_log('error', 'HA service call failed', {"service": service, "error": last_error, "payload": payload})
    raise RuntimeError(last_error or 'HA service call failed')

def run_self_check():
    checks = {}
    alerts = []
    try:
        checks['data_dir_writable'] = {"ok": os.access(DATA_DIR, os.W_OK), "path": DATA_DIR}
    except Exception as e:
        checks['data_dir_writable'] = {"ok": False, "error": str(e)}
    try:
        import subprocess
        r = subprocess.run(['yt-dlp', '--version'], text=True, capture_output=True, timeout=5)
        checks['yt_dlp'] = {"ok": r.returncode == 0, "version": (r.stdout or r.stderr).strip()}
    except Exception as e:
        checks['yt_dlp'] = {"ok": False, "error": str(e)}
    try:
        r = requests.get(f"{HA_URL}/states", headers=ha_headers(), timeout=5)
        ents = r.json() if r.status_code == 200 else []
        mp = [e for e in ents if str(e.get('entity_id', '')).startswith('media_player.')] if isinstance(ents, list) else []
        checks['home_assistant'] = {"ok": r.status_code == 200, "status": r.status_code, "media_players": len(mp)}
        if r.status_code == 200 and len(mp) == 0:
            alerts.append('Không thấy media_player nào từ Home Assistant')
    except Exception as e:
        checks['home_assistant'] = {"ok": False, "error": str(e)}
    with state_lock:
        sess = dict(active_session)
    if sess.get('last_error'):
        alerts.append('Active session đang có lỗi: ' + str(sess.get('last_error'))[:160])
    for name, item in checks.items():
        if not item.get('ok'):
            alerts.append(f"{name} lỗi")
    result = {"time": _now_iso(), "ok": len(alerts) == 0, "version": APP_VERSION, "checks": checks, "alerts": alerts}
    save_json(SELF_CHECK_FILE, result)
    if alerts:
        add_log('warn', 'Self-check alerts', result)
    return result

def self_check_worker():
    while True:
        try:
            run_self_check()
        except Exception as e:
            add_log('error', 'Self-check worker error', {"error": str(e)})
        time.sleep(300)

# --- Global State cho Auto-Resume ---
active_session = {
    "entity_id": None,
    "url": None,          # direct stream URL
    "source_url": None,   # original YouTube URL for refresh
    "title": None,
    "thumbnail": None,
    "mode": "audio",
    "resolution": "auto",
    "should_be_playing": False,
    "last_position": 0,
    "duration": 0,
    "last_update": time.time(),
    "retry_count": 0,
    "last_retry_at": 0,
    "last_error": None
}

# --- Hẹn giờ Worker ---
def timer_worker():
    # More reliable timer loop:
    # - uses last_trigger_date instead of fragile triggered_today reset at second == 0
    # - copies due tasks before executing so slow yt-dlp calls do not block state updates
    global timers
    while True:
        try:
            now_dt = datetime.now()
            now_str = now_dt.strftime("%H:%M")
            today = now_dt.strftime("%Y-%m-%d")
            day_idx = now_dt.weekday() # 0 = Monday
            due_tasks = []
            needs_save = False
            with state_lock:
                for task in timers:
                    days = task.get('days', [])
                    should_run_today = (not days or day_idx in days)
                    already_ran = task.get('last_trigger_date') == today
                    if task.get('time') == now_str and should_run_today and not already_ran:
                        task['last_trigger_date'] = today
                        task['triggered_today'] = True  # kept for backward compatibility/UI data
                        due_tasks.append(dict(task))
                        needs_save = True
                    elif task.get('time') != now_str and task.get('triggered_today'):
                        task['triggered_today'] = False
                        needs_save = True
                if needs_save:
                    save_json(TIMERS_FILE, timers)
            for task in due_tasks:
                execute_timer_task(task)
        except Exception as e:
            logger.error(f"Timer worker error: {e}")
        time.sleep(15)

def execute_timer_task(task):
    global last_timer_run
    headers = ha_headers()
    eid = task.get('entity_id')
    if task['type'] == 'stop':
        with state_lock:
            active_session['should_be_playing'] = False
        last_timer_run = {"time": datetime.now().isoformat(timespec='seconds'), "task_id": task.get('id'), "type": task.get('type'), "entity_id": eid}
        call_ha_service("media_player", "media_stop", {"entity_id": eid}, timeout=10)
    elif task['type'] == 'play':
        pl_name = task.get('playlist_name')
        if pl_name in playlists and playlists[pl_name]:
            if task.get('is_random') is True:
                song = random.choice(playlists[pl_name])
            else:
                song = playlists[pl_name][0]
                
            # Timer chạy cho Loa -> dùng m4a
            ydl_opts = {'format': 'bestaudio[ext=m4a]/bestaudio', 'quiet': True}
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(song['url'], download=False)
                
                with state_lock:
                    active_session.update({
                    "entity_id": eid,
                    "url": info['url'],
                    "source_url": song.get('url'),
                    "title": song.get('title'),
                    "thumbnail": song.get('thumbnail'),
                    "mode": "audio",
                    "resolution": "auto",
                    "should_be_playing": True,
                    "last_position": 0,
                    "retry_count": 0,
                    "last_retry_at": 0,
                    "last_error": None
                    })

                last_timer_run = {"time": datetime.now().isoformat(timespec='seconds'), "task_id": task.get('id'), "type": task.get('type'), "entity_id": eid}
                call_ha_service("media_player", "play_media", {
                    "entity_id": eid, 
                    "media_content_id": info['url'], 
                    "media_content_type": "audio/mp4",
                    "extra": {
                        "title": song.get('title'),
                        "thumb": song.get('thumbnail')
                    }
                }, timeout=10)

            duration = task.get('duration')
            try:
                if duration and int(duration) > 0:
                    delay_sec = int(duration) * 60
                    def delayed_stop():
                        time.sleep(delay_sec)
                        with state_lock:
                            active_session['should_be_playing'] = False
                        call_ha_service("media_player", "media_stop", {"entity_id": eid}, timeout=10)
                    threading.Thread(target=delayed_stop, daemon=True).start()
            except Exception as e:
                logger.error(f"Error setting stop timer: {e}")

threading.Thread(target=timer_worker, daemon=True).start()

def schedule_worker():
    global schedule_rules
    while True:
        try:
            now_dt = datetime.now()
            now_str = now_dt.strftime("%H:%M")
            today = now_dt.strftime("%Y-%m-%d")
            day_idx = now_dt.weekday()
            due_rules = []
            with state_lock:
                for rule in schedule_rules:
                    if not rule.get('enabled', True):
                        continue
                    days = rule.get('days', [])
                    if days and day_idx not in days:
                        continue
                    at = rule.get('at', '')
                    if at and at != now_str:
                        continue
                    if rule.get('last_trigger_date') == today:
                        continue
                    rule['last_trigger_date'] = today
                    due_rules.append(dict(rule))
                if due_rules:
                    save_json(SCHEDULE_RULES_FILE, schedule_rules)
            for rule in due_rules:
                try:
                    result = _play_rule_now(rule)
                    add_log('timer', 'Advanced schedule triggered', {"rule": rule.get('name'), **result})
                except Exception as e:
                    add_log('error', 'Advanced schedule failed', {"rule": rule.get('name'), "error": str(e)})
        except Exception as e:
            add_log('error', 'Schedule worker error', {"error": str(e)})
        time.sleep(20)

threading.Thread(target=schedule_worker, daemon=True).start()

def sleep_timer_worker():
    global sleep_timer
    while True:
        try:
            with state_lock:
                st = dict(sleep_timer) if isinstance(sleep_timer, dict) else {}
            if st.get('enabled') and st.get('end_at'):
                try:
                    end_ts = datetime.fromisoformat(st.get('end_at')).timestamp()
                except Exception:
                    end_ts = 0
                if end_ts and time.time() >= end_ts:
                    eid = st.get('entity_id')
                    if not eid:
                        with state_lock:
                            eid = active_session.get('entity_id') or None
                    if eid and eid != 'browser':
                        call_ha_service("media_player", "media_stop", {"entity_id": eid}, timeout=10)
                    with state_lock:
                        active_session['should_be_playing'] = False
                        sleep_timer = {"enabled": False, "end_at": None, "entity_id": eid, "minutes": st.get('minutes', 0), "last_triggered_at": _now_iso()}
                        save_json(SLEEP_TIMER_FILE, sleep_timer)
                    add_log('timer', 'Sleep timer stopped playback', {"entity_id": eid})
            time.sleep(5)
        except Exception as e:
            add_log('error', 'Sleep timer worker error', {"error": str(e)})
            time.sleep(10)

threading.Thread(target=sleep_timer_worker, daemon=True).start()

# --- WATCHDOG WORKER ---
def watchdog_worker():
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    while True:
        try:
            if not watchdog_enabled:
                time.sleep(2)
                continue
            with state_lock:
                session = dict(active_session)
            if session.get('should_be_playing') and session.get('entity_id'):
                eid = session.get('entity_id')
                r = requests.get(f"{HA_URL}/states/{eid}", headers=headers, timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    state = data.get('state')
                    attr = data.get('attributes', {})
                    media_duration = attr.get('media_duration', 0)
                    
                    if state == 'playing':
                        pos = attr.get('media_position', 0)
                        updated_at = attr.get('media_position_updated_at')
                        if updated_at:
                            diff = (datetime.now(timezone.utc) - datetime.fromisoformat(updated_at.replace('Z', '+00:00'))).total_seconds()
                            pos += diff
                        
                        with state_lock:
                            active_session['last_position'] = pos
                            active_session['duration'] = media_duration
                            active_session['retry_count'] = 0 
                    
                    elif state in ['idle', 'off']:
                        is_track_finished = False
                        if session.get('duration', 0) > 0:
                            if session.get('last_position', 0) > (session.get('duration', 0) - 15): 
                                is_track_finished = True
                        
                        if not is_track_finished and session.get('retry_count', 0) < 3:
                            if time.time() - session.get('last_retry_at', 0) < 20:
                                time.sleep(5)
                                continue
                            time.sleep(4)
                            stream_url = session.get('url')
                            try:
                                # YouTube direct stream URLs can expire; refresh from original source URL before resume.
                                if session.get('source_url'):
                                    info = resolve_youtube_stream(session.get('source_url'), session.get('mode', 'audio'), eid, session.get('resolution', 'auto'))
                                    stream_url = info.get('url') or stream_url
                            except Exception as e:
                                with state_lock:
                                    active_session['last_error'] = str(e)
                            with state_lock:
                                still_should_play = active_session.get('should_be_playing')
                                if still_should_play:
                                    active_session['retry_count'] = active_session.get('retry_count', 0) + 1
                                    active_session['last_retry_at'] = time.time()
                                    if stream_url:
                                        active_session['url'] = stream_url
                            if still_should_play:
                                logger.warning(f"Watchdog: Detected interruption on {eid}. Resuming...")
                                content_type = "video/mp4" if session.get('mode') == 'video' else "audio/mp4"
                                requests.post(f"{HA_URL}/services/media_player/play_media", headers=headers, json={
                                    "entity_id": eid,
                                    "media_content_id": stream_url,
                                    "media_content_type": content_type,
                                    "extra": {
                                        "title": session.get('title'),
                                        "thumb": session.get('thumbnail')
                                    }
                                }, timeout=10)
                                if session.get('last_position', 0) > 5:
                                    time.sleep(2) 
                                    requests.post(f"{HA_URL}/services/media_player/media_seek", headers=headers, json={
                                        "entity_id": eid, 
                                        "seek_position": session.get('last_position', 0)
                                    }, timeout=5)
        except Exception as e: pass
        time.sleep(5)

threading.Thread(target=watchdog_worker, daemon=True).start()
threading.Thread(target=self_check_worker, daemon=True).start()

def resolve_youtube_stream(source_url, mode='audio', target='browser', resolution='auto'):
    """Resolve a fresh playable stream URL from the original YouTube URL."""
    global last_ytdlp_error
    if mode == 'video':
        try:
            h = int(resolution) if str(resolution).isdigit() else None
        except Exception:
            h = None
        if h:
            fmt_candidates = [
                f'best[height<={h}][ext=mp4]',
                f'best[height<={h}]',
                f'bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]',
                f'bestvideo[height<={h}]+bestaudio',
                'best[ext=mp4]',
                'best'
            ]
        else:
            fmt_candidates = [
                'best[height<=720][ext=mp4]',
                'best[height<=720]',
                'best[ext=mp4]',
                'bestvideo[ext=mp4]+bestaudio[ext=m4a]',
                'best'
            ]
    else:
        if target == 'browser':
            fmt_candidates = ['best[height<=360][ext=mp4]', 'best[ext=mp4]', 'bestaudio']
        else:
            fmt_candidates = ['bestaudio[ext=m4a]', 'bestaudio']

    last_err = None
    for fmt in fmt_candidates:
        ydl_opts = {'format': fmt, 'quiet': True, 'noplaylist': True}
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(source_url, download=False)
                last_ytdlp_error = None
                if info and info.get('url'):
                    return info
        except Exception as e:
            last_err = str(e)
            logger.error(f"yt-dlp resolve error ({fmt}): {e}")
            continue
    last_ytdlp_error = last_err or 'Unable to resolve stream'
    raise RuntimeError(last_ytdlp_error)

# --- YouTube Logic ---
def search_youtube(query, offset=1, limit=16):
    ydl_opts = {'quiet': True, 'extract_flat': True, 'skip_download': True, 'playlist_items': f'{offset}-{offset+limit-1}', 'ignoreerrors': True}
    res = []
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            q = query if query and query.strip() != "" else "nhạc trẻ remix 2025"
            info = ydl.extract_info(f"ytsearch{offset+limit}:{q}", download=False)
            if 'entries' in info:
                for e in info['entries']:
                    if e: res.append({"title": e.get('title', '...'), "url": f"https://www.youtube.com/watch?v={e.get('id')}", "thumbnail": f"https://img.youtube.com/vi/{e.get('id')}/mqdefault.jpg", "id": e.get('id')})
    except: pass
    return res


@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/proxy')
def proxy_stream():
    url = request.args.get('url')
    headers = {k: v for k, v in request.headers if k.lower() in ['range', 'user-agent']}
    try:
        r = requests.get(url, headers=headers, stream=True, timeout=30)
        res = Response(stream_with_context(r.iter_content(chunk_size=65536)), status=r.status_code)
        res.headers['Content-Type'] = r.headers.get('Content-Type', 'video/mp4' if 'video' in r.headers.get('Content-Type', '') else 'audio/mpeg')
        res.headers['Accept-Ranges'] = 'bytes'
        if 'Content-Range' in r.headers: res.headers['Content-Range'] = r.headers['Content-Range']
        if 'Content-Length' in r.headers: res.headers['Content-Length'] = r.headers['Content-Length']
        res.headers['Access-Control-Allow-Origin'] = '*'
        return res
    except: return "Error", 500

@app.route('/api/entities')
def entities():
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    try:
        r = requests.get(f"{HA_URL}/states", headers=headers, timeout=5)
        return jsonify(r.json() if r.status_code == 200 else [])
    except: return jsonify([])

@app.route('/api/speaker_state')
def speaker_state():
    eid = request.args.get('entity_id')
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    try:
        r = requests.get(f"{HA_URL}/states/{eid}", headers=headers, timeout=5)
        if r.status_code == 200:
            data = r.json()
            attr = data.get('attributes', {})
            pos = attr.get('media_position', 0)
            updated_at = attr.get('media_position_updated_at')
            if updated_at and data.get('state') == 'playing':
                diff = (datetime.now(timezone.utc) - datetime.fromisoformat(updated_at.replace('Z', '+00:00'))).total_seconds()
                pos += diff
            return jsonify({"state": data.get('state'), "position": pos, "duration": attr.get('media_duration', 0)})
    except: pass
    return jsonify({"state": "unknown"})

@app.route('/api/search', methods=['POST'])
def search_api():
    d = request.json
    return jsonify({"results": search_youtube(d.get('query', ''), offset=d.get('offset', 1))})

@app.route('/api/get_stream', methods=['POST'])
def stream_api():
    data = request.json
    mode = data.get('mode', 'audio')
    target = data.get('target', 'browser')
    resolution = data.get('resolution', 'auto')
    info = resolve_youtube_stream(data.get('url'), mode, target, resolution)
    return jsonify({"stream_url": info['url'], "title": info.get('title')})

@app.route('/api/cast', methods=['POST'])
def cast_api():
    data = request.json
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    entity_id = data.get('entity_id')
    seek_time = data.get('seek_time', 0)
    mode = data.get('mode', 'audio')
    resolution = data.get('resolution', 'auto')
    
    # Cập nhật session cho Auto-Resume Watchdog
    with state_lock:
        active_session.update({
        "entity_id": entity_id,
        "url": data.get('url'),
        "source_url": data.get('source_url'),
        "title": data.get('title'),
        "thumbnail": data.get('thumbnail'),
        "mode": mode,
        "resolution": resolution,
        "should_be_playing": True, # Đánh dấu là hệ thống muốn phát
        "last_position": seek_time,
        "retry_count": 0,
        "last_retry_at": 0,
        "last_error": None
        })

    content_type = "video/mp4" if mode == 'video' else "audio/mp4"
    payload = {
        "entity_id": entity_id, 
        "media_content_id": data.get('url'), 
        "media_content_type": content_type, 
        "extra": {
            "title": data.get('title'),
            "thumb": data.get('thumbnail')
        }
    }
    try:
        call_ha_service("media_player", "play_media", payload, timeout=10)
    except Exception as e:
        with state_lock:
            active_session['last_error'] = str(e)
        add_log("error", "Cast/play failed", {"entity_id": entity_id, "error": str(e)})
        return jsonify({"success": False, "error": str(e)}), 502
    add_log("play", "Cast/play requested", {"entity_id": entity_id, "title": data.get('title'), "mode": mode, "resolution": resolution, "source_url": data.get('source_url')})
    if seek_time > 0:
        def do_seek():
            time.sleep(2)
            try:
                call_ha_service("media_player", "media_seek", {"entity_id": entity_id, "seek_position": seek_time}, timeout=5)
            except Exception as e:
                add_log('warn', 'Seek after cast failed', {"entity_id": entity_id, "error": str(e)})
        threading.Thread(target=do_seek, daemon=True).start()
    return jsonify({"success": True})

@app.route('/api/media_control', methods=['POST'])
def media_control_api():
    data = request.json
    action = data.get('action')
    entity_id = data.get('entity_id')
    
    # Nếu người dùng chủ động bấm Stop/Pause, tắt Auto-Resume
    if action in ['stop', 'pause']:
        with state_lock:
            active_session['should_be_playing'] = False
        
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    service_map = {'stop': 'media_stop', 'next': 'media_next_track', 'previous': 'media_previous_track', 'play': 'media_play', 'pause': 'media_pause'}
    service = service_map.get(action)
    if not service: return jsonify({"success": False}), 400
    try:
        call_ha_service("media_player", service, {"entity_id": entity_id}, timeout=10)
    except Exception as e:
        add_log("error", "Media control failed", {"entity_id": entity_id, "action": action, "error": str(e)})
        return jsonify({"success": False, "error": str(e)}), 502
    add_log("control", "Media control", {"entity_id": entity_id, "action": action})
    return jsonify({"success": True})

@app.route('/api/seek', methods=['POST'])
def seek_api():
    data = request.json
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    payload = {"entity_id": data.get('entity_id'), "seek_position": data.get('position')}
    try:
        call_ha_service("media_player", "media_seek", payload, timeout=10)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 502

@app.route('/api/volume', methods=['POST'])
def volume_api():
    data = request.json
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    payload = {"entity_id": data.get('entity_id'), "volume_level": float(data.get('volume'))}
    try:
        call_ha_service("media_player", "volume_set", payload, timeout=10)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 502

@app.route('/api/playlists', methods=['GET', 'POST'])
def handle_playlists():
    global playlists
    if request.method == 'POST':
        name = request.json.get('name')
        with state_lock:
            if name and name not in playlists:
                playlists[name] = []
                save_json(PLAYLIST_FILE, playlists)
    with state_lock:
        return jsonify(playlists)

@app.route('/api/playlists/<name>', methods=['DELETE'])
def delete_playlist(name):
    global playlists
    with state_lock:
        if name in playlists:
            del playlists[name]
            save_json(PLAYLIST_FILE, playlists)
    return jsonify({"success": True})

@app.route('/api/playlists/<name>/add', methods=['POST'])
def add_to_playlist(name):
    global playlists
    with state_lock:
        if name in playlists:
            playlists[name].append(request.json)
            save_json(PLAYLIST_FILE, playlists)
    return jsonify({"success": True})

@app.route('/api/playlists/<name>/music/<int:idx>', methods=['DELETE'])
def remove_music_from_playlist(name, idx):
    global playlists
    with state_lock:
        if name in playlists and 0 <= idx < len(playlists[name]):
            playlists[name].pop(idx)
            save_json(PLAYLIST_FILE, playlists)
    return jsonify({"success": True})

@app.route('/api/timers', methods=['GET', 'POST'])
def handle_timers():
    global timers
    if request.method == 'POST':
        data = request.json
        tid = data.get('id')
        with state_lock:
            if tid:
                for i, t in enumerate(timers):
                    if t.get('id') == tid:
                        data['last_trigger_date'] = t.get('last_trigger_date')
                        timers[i] = data
                        break
            else:
                data['id'] = str(uuid.uuid4())
                timers.append(data)
            save_json(TIMERS_FILE, timers)
    with state_lock:
        return jsonify(timers)

@app.route('/api/timers/<id>', methods=['DELETE'])
def delete_timer(id):
    global timers
    with state_lock:
        timers = [t for t in timers if t.get('id') != id]
        save_json(TIMERS_FILE, timers)
    return jsonify({"success": True})

@app.route('/api/refresh_stream', methods=['POST'])
def refresh_stream_api():
    data = request.json or {}
    with state_lock:
        session = dict(active_session)
    source_url = data.get('source_url') or session.get('source_url')
    if not source_url:
        return jsonify({"success": False, "error": "missing source_url"}), 400
    mode = data.get('mode') or session.get('mode', 'audio')
    target = data.get('target') or session.get('entity_id') or 'browser'
    resolution = data.get('resolution') or session.get('resolution', 'auto')
    info = resolve_youtube_stream(source_url, mode, target, resolution)
    with state_lock:
        active_session['url'] = info.get('url')
        active_session['source_url'] = source_url
        active_session['resolution'] = resolution
        active_session['last_error'] = None
    return jsonify({"success": True, "stream_url": info.get('url'), "title": info.get('title')})

@app.route('/api/watchdog', methods=['GET', 'POST'])
def watchdog_api():
    global watchdog_enabled
    if request.method == 'POST':
        data = request.json or {}
        watchdog_enabled = bool(data.get('enabled', True))
    return jsonify({"success": True, "enabled": watchdog_enabled})

@app.route('/api/restore', methods=['POST'])
def restore_api():
    global playlists, timers
    data = request.json or {}
    restored = []
    with state_lock:
        if isinstance(data.get('playlists'), dict):
            playlists = data['playlists']
            save_json(PLAYLIST_FILE, playlists)
            restored.append('playlists')
        if isinstance(data.get('timers'), list):
            timers = data['timers']
            save_json(TIMERS_FILE, timers)
            restored.append('timers')
    return jsonify({"success": True, "restored": restored})

@app.route('/api/backup')
def backup_api():
    with state_lock:
        return jsonify({
            "version": APP_VERSION,
            "exported_at": datetime.now().isoformat(timespec='seconds'),
            "playlists": playlists,
            "timers": timers
        })

@app.route('/api/backup_full')
def backup_full_api():
    with state_lock:
        return jsonify({
            "version": APP_VERSION,
            "exported_at": _now_iso(),
            "playlists": playlists,
            "timers": timers,
            "settings": get_settings(),
            "watchdog_enabled": watchdog_enabled,
            "queue": queue,
            "sleep_timer": sleep_timer,
            "recent_history": recent_history,
            "presets": presets
        })

@app.route('/api/restore_full', methods=['POST'])
def restore_full_api():
    global playlists, timers, watchdog_enabled, queue, sleep_timer, recent_history, presets
    data = request.json or {}
    restored = []
    with state_lock:
        if isinstance(data.get('playlists'), dict):
            playlists = data['playlists']
            save_json(PLAYLIST_FILE, playlists)
            restored.append('playlists')
        if isinstance(data.get('timers'), list):
            timers = data['timers']
            save_json(TIMERS_FILE, timers)
            restored.append('timers')
        if isinstance(data.get('settings'), dict):
            set_settings(data.get('settings') or {})
            restored.append('settings')
        if isinstance(data.get('watchdog_enabled'), bool):
            watchdog_enabled = data.get('watchdog_enabled')
            restored.append('watchdog_enabled')
        if isinstance(data.get('queue'), list):
            queue = data.get('queue')
            save_json(QUEUE_FILE, queue)
            restored.append('queue')
        if isinstance(data.get('sleep_timer'), dict):
            sleep_timer = data.get('sleep_timer')
            save_json(SLEEP_TIMER_FILE, sleep_timer)
            restored.append('sleep_timer')
        if isinstance(data.get('recent_history'), list):
            recent_history = data.get('recent_history')[-80:]
            save_json(RECENT_HISTORY_FILE, recent_history)
            restored.append('recent_history')
        if isinstance(data.get('presets'), list):
            presets = data.get('presets')[-40:]
            save_json(PRESETS_FILE, presets)
            restored.append('presets')
    add_log('info', 'Restore full applied', {"restored": restored})
    return jsonify({"success": True, "restored": restored})

@app.route('/api/self_check')
def self_check_api():
    latest = load_json(SELF_CHECK_FILE, {})
    if not latest:
        latest = run_self_check()
    return jsonify(latest)

@app.route('/api/self_check/run', methods=['POST'])
def self_check_run_api():
    return jsonify(run_self_check())

@app.route('/api/debug')
def debug_api():
    with state_lock:
        sess = dict(active_session)
        timers_count = len(timers)
        playlists_count = len(playlists)
    safe_session = dict(sess)
    if safe_session.get('url'):
        safe_session['url'] = safe_session['url'][:80] + '...'
    uptime_sec = int(time.time() - APP_START_TIME)
    return jsonify({
        "ok": True,
        "version": APP_VERSION,
        "time": datetime.now().isoformat(timespec='seconds'),
        "uptime_sec": uptime_sec,
        "active_session": safe_session,
        "timers_count": timers_count,
        "playlists_count": playlists_count,
        "last_timer_run": last_timer_run,
        "last_ytdlp_error": last_ytdlp_error,
        "watchdog_enabled": watchdog_enabled
    })

@app.route('/api/healthz')
def healthz_api():
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    ha_ok = False
    ha_status = None
    try:
        r = requests.get(f"{HA_URL}/", headers=headers, timeout=5)
        ha_ok = r.status_code in (200, 401, 403)
        ha_status = r.status_code
    except Exception as e:
        ha_status = str(e)
    with state_lock:
        should_play = bool(active_session.get('should_be_playing'))
        eid = active_session.get('entity_id')
    return jsonify({
        "ok": True,
        "version": APP_VERSION,
        "uptime_sec": int(time.time() - APP_START_TIME),
        "ha_ok": ha_ok,
        "ha_status": ha_status,
        "supervisor_token_present": bool(SUPERVISOR_TOKEN),
        "active_should_be_playing": should_play,
        "active_entity_id": eid,
        "watchdog_enabled": watchdog_enabled
    })

@app.route('/debug')
def debug_page():
    return '<pre id="out">Loading...</pre><script>fetch("./api/debug").then(r=>r.json()).then(j=>out.textContent=JSON.stringify(j,null,2)).catch(e=>out.textContent=e)</script>'

@app.route('/api/export')
def export_api():
    """Lightweight debug/export bundle without secrets."""
    with state_lock:
        return jsonify({
            "version": APP_VERSION,
            "exported_at": datetime.now().isoformat(timespec='seconds'),
            "playlists": playlists,
            "timers": timers,
            "active_session": {
                k: (v[:80] + '...' if k == 'url' and isinstance(v, str) else v)
                for k, v in active_session.items()
            },
            "last_timer_run": last_timer_run,
            "last_ytdlp_error": last_ytdlp_error
        })

@app.route('/api/queue', methods=['GET', 'POST', 'DELETE'])
def queue_api():
    global queue
    if request.method == 'GET':
        with state_lock:
            return jsonify(queue)

    if request.method == 'DELETE':
        idx = request.args.get('idx')
        with state_lock:
            if idx is None:
                queue = []
            else:
                try:
                    i = int(idx)
                    if 0 <= i < len(queue):
                        queue.pop(i)
                except Exception:
                    pass
            save_json(QUEUE_FILE, queue)
            return jsonify({"success": True, "queue": queue})

    item = request.json or {}
    with state_lock:
        queue.append({
            "title": item.get('title', ''),
            "url": item.get('url', ''),
            "thumbnail": item.get('thumbnail', ''),
            "added_at": _now_iso()
        })
        save_json(QUEUE_FILE, queue)
        return jsonify({"success": True, "queue": queue})

@app.route('/api/queue/pop', methods=['POST'])
def queue_pop_api():
    global queue
    with state_lock:
        if not queue:
            return jsonify({"success": False, "error": "empty"}), 404
        item = queue.pop(0)
        save_json(QUEUE_FILE, queue)
        return jsonify({"success": True, "item": item, "queue": queue})

@app.route('/api/queue/reorder', methods=['POST'])
def queue_reorder_api():
    global queue
    data = request.json or {}
    try:
        src = int(data.get('from'))
        dst = int(data.get('to'))
    except Exception:
        return jsonify({"success": False, "error": "invalid index"}), 400
    with state_lock:
        if src < 0 or src >= len(queue) or dst < 0 or dst >= len(queue):
            return jsonify({"success": False, "error": "out of range"}), 400
        item = queue.pop(src)
        queue.insert(dst, item)
        save_json(QUEUE_FILE, queue)
        return jsonify({"success": True, "queue": queue})

@app.route('/api/sleep_timer', methods=['GET', 'POST', 'DELETE'])
def sleep_timer_api():
    global sleep_timer
    if request.method == 'GET':
        with state_lock:
            st = dict(sleep_timer) if isinstance(sleep_timer, dict) else {}
        if st.get('enabled') and st.get('end_at'):
            try:
                st['remaining_sec'] = max(0, int(datetime.fromisoformat(st['end_at']).timestamp() - time.time()))
            except Exception:
                st['remaining_sec'] = 0
        return jsonify(st)

    if request.method == 'DELETE':
        with state_lock:
            sleep_timer = {"enabled": False, "end_at": None, "entity_id": None, "minutes": 0}
            save_json(SLEEP_TIMER_FILE, sleep_timer)
        add_log('timer', 'Sleep timer cancelled', {})
        return jsonify({"success": True, "sleep_timer": sleep_timer})

    data = request.json or {}
    try:
        minutes = int(data.get('minutes', 0))
    except Exception:
        minutes = 0
    if minutes <= 0 or minutes > 720:
        return jsonify({"success": False, "error": "minutes must be 1-720"}), 400
    end_at = (datetime.now() + timedelta(minutes=minutes)).isoformat(timespec='seconds')
    with state_lock:
        eid = data.get('entity_id') or active_session.get('entity_id')
        sleep_timer = {"enabled": True, "end_at": end_at, "entity_id": eid, "minutes": minutes, "created_at": _now_iso()}
        save_json(SLEEP_TIMER_FILE, sleep_timer)
    add_log('timer', 'Sleep timer set', sleep_timer)
    return jsonify({"success": True, "sleep_timer": sleep_timer})

@app.route('/api/recent_history', methods=['GET', 'POST', 'DELETE'])
def recent_history_api():
    global recent_history
    if request.method == 'GET':
        with state_lock:
            return jsonify(recent_history[-80:])
    if request.method == 'DELETE':
        with state_lock:
            recent_history = []
            save_json(RECENT_HISTORY_FILE, recent_history)
        return jsonify({"success": True})
    item = request.json or {}
    url = item.get('url') or item.get('source_url') or ''
    if not url:
        return jsonify({"success": False, "error": "missing url"}), 400
    row = {
        "title": item.get('title', ''),
        "url": url,
        "thumbnail": item.get('thumbnail', ''),
        "mode": item.get('mode', 'audio'),
        "entity_id": item.get('entity_id'),
        "played_at": _now_iso()
    }
    with state_lock:
        recent_history = [x for x in recent_history if x.get('url') != url]
        recent_history.append(row)
        recent_history = recent_history[-80:]
        save_json(RECENT_HISTORY_FILE, recent_history)
    return jsonify({"success": True, "history": recent_history})

@app.route('/api/presets', methods=['GET', 'POST', 'DELETE'])
def presets_api():
    global presets
    if request.method == 'GET':
        with state_lock:
            return jsonify(presets)
    if request.method == 'DELETE':
        pid = request.args.get('id')
        with state_lock:
            if pid:
                presets = [p for p in presets if p.get('id') != pid]
            else:
                presets = []
            save_json(PRESETS_FILE, presets)
        return jsonify({"success": True, "presets": presets})
    data = request.json or {}
    preset_id = data.get('id') or str(uuid.uuid4())
    preset = {
        "id": preset_id,
        "name": (data.get('name') or 'Preset')[:80],
        "group": (data.get('group') or 'Mặc định')[:80],
        "url": data.get('url') or data.get('source_url') or '',
        "title": data.get('title') or data.get('name') or '',
        "thumbnail": data.get('thumbnail', ''),
        "entity_id": data.get('entity_id') or 'browser',
        "mode": data.get('mode', 'audio'),
        "resolution": data.get('resolution', 'auto'),
        "created_at": data.get('created_at') or _now_iso(),
        "updated_at": _now_iso()
    }
    if not preset['url']:
        return jsonify({"success": False, "error": "missing url"}), 400
    with state_lock:
        presets = [p for p in presets if p.get('id') != preset['id']]
        presets.append(preset)
        presets = presets[-80:]
        save_json(PRESETS_FILE, presets)
    return jsonify({"success": True, "preset": preset, "presets": presets})

@app.route('/api/presets/<pid>/duplicate', methods=['POST'])
def duplicate_preset_api(pid):
    global presets
    with state_lock:
        src = next((p for p in presets if p.get('id') == pid), None)
        if not src:
            return jsonify({"success": False, "error": "not found"}), 404
        newp = dict(src)
        newp['id'] = str(uuid.uuid4())
        newp['name'] = (str(src.get('name') or 'Preset') + ' copy')[:80]
        newp['created_at'] = _now_iso()
        newp['updated_at'] = _now_iso()
        presets.append(newp)
        presets = presets[-80:]
        save_json(PRESETS_FILE, presets)
    return jsonify({"success": True, "preset": newp, "presets": presets})

@app.route('/api/schedule_rules', methods=['GET', 'POST'])
def schedule_rules_api():
    global schedule_rules
    if request.method == 'GET':
        with state_lock:
            enriched = []
            for r in schedule_rules:
                row = dict(r)
                nxt = _next_run_for_rule(row)
                row['next_run'] = nxt.isoformat(timespec='minutes') if nxt else None
                enriched.append(row)
            return jsonify(enriched)
    data = request.json or {}
    rid = data.get('id') or str(uuid.uuid4())
    rule = {
        "id": rid,
        "name": (data.get('name') or 'Lịch nâng cao')[:80],
        "at": data.get('at') or '',
        "entity_id": data.get('entity_id') or '',
        "playlist_name": data.get('playlist_name') or '',
        "days": data.get('days') if isinstance(data.get('days'), list) else [],
        "enabled": bool(data.get('enabled', True)),
        "is_random": bool(data.get('is_random', True)),
        "created_at": data.get('created_at') or _now_iso(),
        "updated_at": _now_iso()
    }
    if not rule['at'] or not rule['entity_id'] or not rule['playlist_name']:
        return jsonify({"success": False, "error": "missing at/entity_id/playlist_name"}), 400
    with state_lock:
        old = next((r for r in schedule_rules if r.get('id') == rid), None)
        if old:
            rule['last_trigger_date'] = old.get('last_trigger_date')
            rule['created_at'] = old.get('created_at') or rule['created_at']
        schedule_rules = [r for r in schedule_rules if r.get('id') != rid]
        schedule_rules.append(rule)
        schedule_rules = schedule_rules[-100:]
        save_json(SCHEDULE_RULES_FILE, schedule_rules)
    return jsonify({"success": True, "rule": rule, "schedule_rules": schedule_rules})

@app.route('/api/schedule_rules/<rid>/toggle', methods=['POST'])
def schedule_rules_toggle_api(rid):
    global schedule_rules
    data = request.json or {}
    with state_lock:
        found = False
        for r in schedule_rules:
            if r.get('id') == rid:
                r['enabled'] = bool(data.get('enabled', not r.get('enabled', True)))
                r['updated_at'] = _now_iso()
                found = True
                break
        if not found:
            return jsonify({"success": False, "error": "not found"}), 404
        save_json(SCHEDULE_RULES_FILE, schedule_rules)
    return jsonify({"success": True, "schedule_rules": schedule_rules})

@app.route('/api/schedule_rules/<rid>/duplicate', methods=['POST'])
def schedule_rules_duplicate_api(rid):
    global schedule_rules
    with state_lock:
        src = next((r for r in schedule_rules if r.get('id') == rid), None)
        if not src:
            return jsonify({"success": False, "error": "not found"}), 404
        newr = dict(src)
        newr['id'] = str(uuid.uuid4())
        newr['name'] = (str(src.get('name') or 'Lịch nâng cao') + ' copy')[:80]
        newr['enabled'] = False
        newr.pop('last_trigger_date', None)
        newr['created_at'] = _now_iso()
        newr['updated_at'] = _now_iso()
        schedule_rules.append(newr)
        schedule_rules = schedule_rules[-100:]
        save_json(SCHEDULE_RULES_FILE, schedule_rules)
    return jsonify({"success": True, "rule": newr, "schedule_rules": schedule_rules})

@app.route('/api/schedule_rules/<rid>/run', methods=['POST'])
def schedule_rules_run_api(rid):
    with state_lock:
        rule = next((dict(r) for r in schedule_rules if r.get('id') == rid), None)
    if not rule:
        return jsonify({"success": False, "error": "not found"}), 404
    try:
        result = _play_rule_now(rule)
        add_log('timer', 'Advanced schedule manual run', {"rule": rule.get('name'), **result})
        return jsonify({"success": True, "result": result})
    except Exception as e:
        add_log('error', 'Advanced schedule manual run failed', {"rule": rule.get('name'), "error": str(e)})
        return jsonify({"success": False, "error": str(e)}), 502

@app.route('/api/schedule_rules/<rid>', methods=['DELETE'])
def schedule_rules_delete_api(rid):
    global schedule_rules
    with state_lock:
        schedule_rules = [r for r in schedule_rules if r.get('id') != rid]
        save_json(SCHEDULE_RULES_FILE, schedule_rules)
    return jsonify({"success": True})

@app.route('/api/settings', methods=['GET', 'POST'])
def settings_api():
    if request.method == 'POST':
        return jsonify({"success": True, "settings": set_settings(request.json or {})})
    return jsonify(get_settings())

@app.route('/api/test_provider', methods=['POST'])
def test_provider_api():
    data = request.json or {}
    settings = set_settings(data)
    started = time.time()
    ok = False
    err = None
    sample_count = 0
    try:
        sample = search_youtube('test music', offset=1, limit=3)
        sample_count = len(sample)
        ok = sample_count > 0
        if not ok:
            err = 'No search results returned'
    except Exception as e:
        err = str(e)
    row = {
        "time": _now_iso(),
        "ok": ok,
        "provider": settings.get('provider'),
        "model": settings.get('model'),
        "latency_ms": int((time.time() - started) * 1000),
        "sample_count": sample_count,
        "error": err
    }
    hist = load_json(TEST_HISTORY_FILE, [])
    hist.append(row)
    hist = hist[-100:]
    save_json(TEST_HISTORY_FILE, hist)
    add_log('test' if ok else 'error', 'Provider/model test ' + ('OK' if ok else 'FAILED'), row)
    return jsonify(row)

@app.route('/api/test_history')
def test_history_api():
    return jsonify(load_json(TEST_HISTORY_FILE, [])[-100:])

@app.route('/api/logs', methods=['GET', 'DELETE'])
def logs_api():
    if request.method == 'DELETE':
        save_json(LOG_FILE, [])
        return jsonify({"success": True})
    return jsonify(load_json(LOG_FILE, [])[-300:])

@app.route('/api/health_detail')
def health_detail_api():
    headers = {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}
    checks = {}
    try:
        import subprocess
        r = subprocess.run(['yt-dlp', '--version'], text=True, capture_output=True, timeout=5)
        checks['yt_dlp'] = {"ok": r.returncode == 0, "version": (r.stdout or r.stderr).strip()}
    except Exception as e:
        checks['yt_dlp'] = {"ok": False, "error": str(e)}
    try:
        r = requests.get(f"{HA_URL}/states", headers=headers, timeout=5)
        ents = r.json() if r.status_code == 200 else []
        mp = [e for e in ents if str(e.get('entity_id', '')).startswith('media_player.')] if isinstance(ents, list) else []
        checks['home_assistant'] = {"ok": r.status_code == 200, "status": r.status_code, "media_players": len(mp)}
    except Exception as e:
        checks['home_assistant'] = {"ok": False, "error": str(e)}
    with state_lock:
        pc, tc, sess = len(playlists), len(timers), dict(active_session)
    return jsonify({
        "ok": all(v.get('ok') for v in checks.values()),
        "version": APP_VERSION,
        "uptime_sec": int(time.time() - APP_START_TIME),
        "settings": get_settings(),
        "checks": checks,
        "data": {
            "playlists": pc,
            "timers": tc,
            "logs": len(load_json(LOG_FILE, [])),
            "tests": len(load_json(TEST_HISTORY_FILE, []))
        },
        "active_session": mask_obj(sess),
        "watchdog_enabled": watchdog_enabled,
        "self_check": load_json(SELF_CHECK_FILE, {})
    })

@app.route('/api/debug_bundle')
def debug_bundle_api():
    with state_lock:
        bundle = {
            "version": APP_VERSION,
            "exported_at": _now_iso(),
            "settings": get_settings(),
            "playlists": playlists,
            "timers": timers,
            "active_session": dict(active_session),
            "logs": load_json(LOG_FILE, [])[-300:],
            "test_history": load_json(TEST_HISTORY_FILE, [])[-100:],
            "environment": {
                "SUPERVISOR_TOKEN": mask_secret_value(SUPERVISOR_TOKEN),
                "HA_URL": HA_URL
            }
        }
    return jsonify(mask_obj(bundle))

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=2232)


