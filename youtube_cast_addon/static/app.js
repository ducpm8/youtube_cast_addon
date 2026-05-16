const API_BASE = window.location.pathname.replace(/\/$/, "");
        const audio = document.getElementById('player');
        const video = document.getElementById('videoPlayer');
        
        function esc(s) {
            return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
        }
        async function apiJson(url, options) {
            const r = await fetch(url, options);
            let d = null;
            try { d = await r.json(); } catch(e) {}
            if(!r.ok || (d && d.success === false)) {
                const err = (d && (d.error || d.message)) || `HTTP ${r.status}`;
                throw new Error(err);
            }
            return d;
        }
        function toast(msg, type='info') {
            const box = document.getElementById('toastBox');
            if(!box) return;
            const el = document.createElement('div');
            el.className = `toast-item ${type}`;
            el.textContent = msg;
            box.appendChild(el);
            setTimeout(() => el.classList.add('show'), 10);
            setTimeout(() => {
                el.classList.remove('show');
                setTimeout(() => el.remove(), 240);
            }, 2200);
        }
        function setBtnLoading(el, loading, normalText='') {
            if(!el) return;
            if(loading) {
                el.dataset.oldText = el.innerHTML;
                el.disabled = true;
                el.classList.add('opacity-70');
                el.innerHTML = '<span class="inline-flex items-center gap-2"><span class="tiny-spin"></span>Đang xử lý</span>';
            } else {
                el.disabled = false;
                el.classList.remove('opacity-70');
                el.innerHTML = normalText || el.dataset.oldText || el.innerHTML;
            }
        }

        let currentMediaElement = audio;
        let playerMode = 'audio';
        let playlist = [], currentIndex = -1, isRepeat = false, songToAdd = null, isSeeking = false;
        let offset = 1, searchQuery = "", isLoadingMore = false, currentTimerDays = [], activeSpeaker = 'browser', currentTimerRandom = false;
        let advancedDays = [];
        let advancedEditId = '';
        let advancedEditEnabled = true;
        let speakers = [];
        let isShuffle = false;
        let videoResolution = localStorage.getItem('videoResolution') || 'auto';
        let smoothMode = localStorage.getItem('smoothMode') === '1';
        let videoStallCount = 0;
        const RESOLUTION_STEPS = ['1080', '720', '480', '360', '240', '144'];

        async function init() {
            if(localStorage.getItem('theme') === 'light') toggleTheme();
            const resSel = document.getElementById('resolutionSelect');
            if(resSel) resSel.value = videoResolution;
            updateSmoothModeButton();
            setupSmoothFallback();
            setupTouchGestures();
            updateResolutionControl();
            await fetchSpeakers();
            await loadPlaylists();
            await performNewSearch(); 
            const handleTimeUpdate = () => {
                if(activeSpeaker === 'browser' && currentMediaElement.duration && !isSeeking){
                    const p = (currentMediaElement.currentTime/currentMediaElement.duration)*100;
                    updateUIProgress(currentMediaElement.currentTime, currentMediaElement.duration, p);
                }
            };
            audio.ontimeupdate = video.ontimeupdate = handleTimeUpdate;
            audio.onended = video.onended = async () => {
                if(isRepeat) { currentMediaElement.currentTime=0; currentMediaElement.play(); return; }
                if(await playNextFromQueue()) return;
                next();
            };
            const obs = new IntersectionObserver(ent => { if(ent[0].isIntersecting && !isLoadingMore) loadMore(); }, { root: document.getElementById('mainScroll'), threshold: 0.1 });
            obs.observe(document.getElementById('sentinel'));

            setInterval(syncSpeakerState, 3000); 
            startSleepTimerTicker();
            await renderQueueList();
            await refreshSleepTimerUI();
            await renderRecentHistory();
            await renderPresets();
            await loadAdvancedSchedules();
        }

        function updateUIProgress(cur, dur, pct) {
            document.getElementById('fProg').value = pct;
            document.getElementById('curT').innerText = fmt(cur);
            document.getElementById('totT').innerText = fmt(dur);
        }

        function updateQuickStatus(stateText) {
            const dev = document.getElementById('qsDevice');
            const mode = document.getElementById('qsMode');
            const state = document.getElementById('qsState');
            if(dev) {
                if(activeSpeaker === 'browser') dev.textContent = '📱 Điện thoại';
                else {
                    const spk = speakers.find(s => s.entity_id === activeSpeaker);
                    dev.textContent = '🔊 ' + ((spk?.attributes?.friendly_name || 'Loa').slice(0, 18));
                }
            }
            if(mode) {
                if(playerMode === 'video') {
                    const q = (videoResolution === 'auto' ? 'Auto' : videoResolution + 'p');
                    mode.textContent = `🎬 ${q}${smoothMode ? ' • Mượt' : ''}`;
                } else {
                    mode.textContent = '🎵 Bài hát';
                }
            }
            if(state && stateText) state.textContent = stateText;
        }

        function updateResolutionControl() {
            const el = document.getElementById('resolutionSelect');
            const smoothBtn = document.getElementById('smoothModeBtn');
            const zoomBtn = document.getElementById('videoZoomBtn');
            if(el) el.classList.toggle('hidden', playerMode !== 'video');
            if(smoothBtn) smoothBtn.classList.toggle('hidden', playerMode !== 'video');
            if(zoomBtn) zoomBtn.classList.toggle('hidden', playerMode !== 'video');
            if(playerMode !== 'video') setVideoZoom(false);
            updateSmoothModeButton();
            updateQuickStatus();
        }

        function updateSmoothModeButton() {
            const btn = document.getElementById('smoothModeBtn');
            if(!btn) return;
            btn.textContent = smoothMode ? 'Mượt: ON' : 'Mượt: OFF';
            btn.classList.toggle('bg-red-600', smoothMode);
            btn.classList.toggle('text-white', smoothMode);
            btn.classList.toggle('bg-zinc-500/10', !smoothMode);
            btn.classList.toggle('text-zinc-400', !smoothMode);
        }

        function setVideoZoom(on) {
            const box = document.getElementById('videoContainer');
            const icon = document.getElementById('videoZoomIcon');
            if(!box) return;
            box.classList.toggle('zoomed', !!on);
            document.body.classList.toggle('video-zoom-active', !!on);
            if(icon) {
                icon.innerHTML = on
                    ? '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>'
                    : '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zm0-12V5h-3v2h3v3h2V5h-2z"/>';
            }
        }

        function toggleVideoZoom(e) {
            if(e) e.stopPropagation();
            if(playerMode !== 'video') return;
            const box = document.getElementById('videoContainer');
            setVideoZoom(!(box && box.classList.contains('zoomed')));
        }

        function setupTouchGestures() {
            const full = document.getElementById('fullPlayer');
            const mini = document.getElementById('miniPlayer');
            const media = document.getElementById('mediaDisplay');
            if(!full || full.dataset.gestureReady === '1') return;
            full.dataset.gestureReady = '1';

            let sx = 0, sy = 0, dx = 0, dy = 0, startAt = 0, dragging = false, moved = false;
            const isInteractive = el => !!(el && el.closest && el.closest('button, input, select, textarea, .debug-shell, #devicePicker, #plPicker'));
            const isActive = () => full.classList.contains('active');
            const resetFullTransform = () => {
                full.style.transition = '';
                full.style.transform = '';
                if(media) {
                    media.style.transform = '';
                    media.style.opacity = '';
                }
            };

            full.addEventListener('touchstart', e => {
                if(!isActive() || isInteractive(e.target) || e.touches.length !== 1) return;
                sx = e.touches[0].clientX;
                sy = e.touches[0].clientY;
                dx = dy = 0;
                startAt = Date.now();
                dragging = true;
                moved = false;
                full.style.transition = 'none';
            }, {passive: true});

            full.addEventListener('touchmove', e => {
                if(!dragging || e.touches.length !== 1) return;
                dx = e.touches[0].clientX - sx;
                dy = e.touches[0].clientY - sy;
                const absX = Math.abs(dx), absY = Math.abs(dy);
                if(absX < 10 && absY < 10) return;
                moved = true;
                if(absY > absX && dy > 0) {
                    full.style.transform = `translateY(${Math.min(dy, window.innerHeight)}px)`;
                } else if(absX > absY) {
                    const drift = Math.max(-70, Math.min(70, dx * 0.22));
                    if(media) {
                        media.style.transform = `translateX(${drift}px) scale(${1 - Math.min(absX, 260) / 2600})`;
                        media.style.opacity = String(1 - Math.min(absX, 260) / 900);
                    }
                }
            }, {passive: true});

            full.addEventListener('touchend', () => {
                if(!dragging) return;
                dragging = false;
                const elapsed = Math.max(1, Date.now() - startAt);
                const vx = Math.abs(dx) / elapsed;
                const vy = Math.abs(dy) / elapsed;
                full.style.transition = '';

                if(dy > 95 && Math.abs(dy) > Math.abs(dx) * 1.25 && (dy > 150 || vy > 0.55)) {
                    closeFullPlayer();
                    setTimeout(resetFullTransform, 260);
                    return;
                }
                if(Math.abs(dx) > 85 && Math.abs(dx) > Math.abs(dy) * 1.35 && (Math.abs(dx) > 130 || vx > 0.55)) {
                    dx < 0 ? next() : prev();
                    updateQuickStatus(dx < 0 ? '⏭️ Bài tiếp theo' : '⏮️ Bài trước');
                }
                resetFullTransform();
            }, {passive: true});

            if(media) {
                media.addEventListener('click', e => {
                    if(moved || isInteractive(e.target) || currentIndex < 0) return;
                    togglePlay();
                });
            }

            if(mini && mini.dataset.gestureReady !== '1') {
                mini.dataset.gestureReady = '1';
                let msx = 0, msy = 0;
                mini.addEventListener('touchstart', e => {
                    if(e.touches.length !== 1) return;
                    msx = e.touches[0].clientX;
                    msy = e.touches[0].clientY;
                }, {passive: true});
                mini.addEventListener('touchend', e => {
                    const t = e.changedTouches && e.changedTouches[0];
                    if(!t) return;
                    const mdx = t.clientX - msx;
                    const mdy = t.clientY - msy;
                    if(mdy < -35 && Math.abs(mdy) > Math.abs(mdx)) openFullPlayer();
                }, {passive: true});
            }
        }

        async function toggleSmoothMode() {
            smoothMode = !smoothMode;
            localStorage.setItem('smoothMode', smoothMode ? '1' : '0');
            videoStallCount = 0;
            updateSmoothModeButton();
            updateQuickStatus(smoothMode ? '✅ Ưu tiên mượt' : '🎬 Chất lượng thường');
        }

        function lowerResolutionValue(cur) {
            if(!cur || cur === 'auto') return '720';
            const i = RESOLUTION_STEPS.indexOf(String(cur));
            if(i < 0) return '720';
            return RESOLUTION_STEPS[Math.min(i + 1, RESOLUTION_STEPS.length - 1)];
        }

        function setupSmoothFallback() {
            if(!video) return;
            video.addEventListener('waiting', handleVideoStall);
            video.addEventListener('stalled', handleVideoStall);
            video.addEventListener('error', handleVideoStall);
            video.addEventListener('canplay', () => { videoStallCount = 0; });
        }

        async function handleVideoStall() {
            if(!smoothMode || playerMode !== 'video' || currentIndex < 0) return;
            videoStallCount += 1;
            if(videoStallCount < 2) return;
            videoStallCount = 0;
            const nextRes = lowerResolutionValue(videoResolution);
            if(nextRes === videoResolution) return;
            const sel = document.getElementById('resolutionSelect');
            if(sel) sel.value = nextRes;
            updateQuickStatus(`📉 Hạ xuống ${nextRes}p cho mượt`);
            await changeResolution(nextRes);
        }

        const fmt = s => { const m=Math.floor(s/60), sc=Math.floor(s%60); return `${m}:${sc<10?'0':''}${sc}`; };

        async function syncSpeakerState() {
            if(activeSpeaker === 'browser' || isSeeking) return;
            try {
                const r = await fetch(API_BASE + `/api/speaker_state?entity_id=${activeSpeaker}`);
                const data = await r.json();
                if(data.state && data.state !== 'unavailable') {
                    updateIcons(data.state === 'playing');
                    if(data.duration > 0) {
                        const pct = (data.position / data.duration) * 100;
                        updateUIProgress(data.position, data.duration, pct);
                    }
                }
            } catch(e) {}
        }

        async function fetchSpeakers() {
            const r = await fetch(API_BASE+'/api/entities');
            const d = await r.json();
            speakers = d.filter(e => e.entity_id.startsWith('media_player.'));
            const sL = document.getElementById('speakerList'), tS = document.getElementById('tSpeaker'), advS = document.getElementById('advSpeaker');
            speakers.forEach(p => {
                const name = (p.attributes.friendly_name || p.entity_id).toUpperCase();
                sL.add(new Option("🔊 "+name, p.entity_id));
                if(tS) tS.add(new Option(name, p.entity_id));
                if(advS) advS.add(new Option(name, p.entity_id));
            });
        }

        async function selectDevice(id) { 
            const curTime = currentMediaElement.currentTime;
            
            if(activeSpeaker !== 'browser' && activeSpeaker !== id) {
                 await fetch(API_BASE+'/api/media_control', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ entity_id: activeSpeaker, action: 'stop' }) 
                 });
            }

            activeSpeaker = id; 
            updateQuickStatus();
            document.getElementById('speakerList').value = id; 
            closeDevicePicker(); 
            const castRemote = document.getElementById('castRemote');
            const volControl = document.getElementById('volControl');
            if(id !== 'browser') {
                castRemote.classList.remove('hidden');
                volControl.classList.remove('hidden');
                const spk = speakers.find(s => s.entity_id === id);
                document.getElementById('remoteDeviceName').innerText = (spk?.attributes?.friendly_name || 'LOA').toUpperCase();
            } else {
                castRemote.classList.add('hidden');
                volControl.classList.add('hidden');
            }
            if(currentIndex !== -1) play(currentIndex, curTime); 
        }

        function openDevicePicker() {
            const items = document.getElementById('deviceItems');
            const browserActive = activeSpeaker === 'browser';
            items.innerHTML = `<button onclick="selectDevice('browser')" class="w-full p-4 rounded-2xl text-left flex justify-between items-center ${browserActive ? 'bg-red-600 text-white' : 'bg-zinc-500/10'}"><div class="flex items-center gap-3"><svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg><span class="font-bold text-xs uppercase">Điện thoại này</span></div></button>` + speakers.map(s => {
                const active = activeSpeaker === s.entity_id;
                return `<button onclick="selectDevice('${s.entity_id}')" class="w-full p-4 rounded-2xl text-left flex justify-between items-center ${active ? 'bg-red-600 text-white' : 'bg-zinc-500/10'}"><div class="flex items-center gap-3"><svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M18 2.01L6 2c-1.1 0-2 .89-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.11-.9-1.99-2-1.99zM18 20H6V4h12v16zm-4-9h2V5h-2v6zm-4 4h2V5h-2v10zm-4 4h2V5H6v14z"/></svg><span class="font-bold text-xs uppercase">${s.attributes.friendly_name || s.entity_id}</span></div></button>`;
            }).join('');
            document.getElementById('devicePicker').classList.remove('hidden');
        }

        function closeDevicePicker() { document.getElementById('devicePicker').classList.add('hidden'); }

        async function setVolume(val) {
            if (activeSpeaker === 'browser') { audio.volume = video.volume = val; }
            else { await fetch(API_BASE+'/api/volume', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ entity_id: activeSpeaker, volume: val }) }); }
        }

        async function castControl(action) {
            if(activeSpeaker === 'browser') return;
            await fetch(API_BASE+'/api/media_control', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ entity_id: activeSpeaker, action: action }) });
            if(action === 'stop') updateIcons(false);
            setTimeout(syncSpeakerState, 500);
        }

        async function performNewSearch() {
            searchQuery = document.getElementById('searchInput').value; offset = 1; playlist = [];
            document.getElementById('section-home').innerHTML = '';
            showSkeletons(); await loadMore();
        }

        async function loadMore() {
            if(isLoadingMore) return;
            isLoadingMore = true; document.getElementById('bottomLoader').classList.remove('hidden');
            try {
                const r = await fetch(API_BASE+'/api/search', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ query: searchQuery, offset: offset }) });
                const d = await r.json();
                if(d.results && d.results.length > 0) {
                    const sIdx = playlist.length; playlist = [...playlist, ...d.results];
                    renderItems(d.results, sIdx); offset += d.results.length;
                }
            } catch(e){} finally { isLoadingMore = false; document.getElementById('bottomLoader').classList.add('hidden'); document.querySelectorAll('.skel').forEach(e => e.remove()); }
        }

        function showSkeletons() {
            const c = document.getElementById('section-home');
            for(let i=0; i<6; i++) {
                const d = document.createElement('div'); d.className = "skel glass-card p-2.5";
                d.innerHTML = `<div class="aspect-square rounded-xl skeleton mb-2"></div><div class="h-2 skeleton rounded w-3/4"></div>`;
                c.appendChild(d);
            }
        }

        function renderItems(items, startIdx) {
            const c = document.getElementById('section-home');
            items.forEach((v, i) => {
                const idx = startIdx + i;
                const d = document.createElement('div');
                d.className = "song-card";
                d.onclick = () => play(idx);
                d.innerHTML = `<div class="song-thumb"><img src="${v.thumbnail}" class="w-full h-full object-cover" loading="lazy"></div><div class="absolute top-2 left-2 flex gap-1"><button onclick="event.stopPropagation(); addToQueueByIndex(${idx})" class="floating-add active:scale-90 transition-transform" title="Thêm hàng chờ"><svg width="10" height="10" fill="white" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button></div><button onclick="event.stopPropagation(); openPicker(${idx})" class="floating-add active:scale-90 transition-transform" style="right:8px"><svg width="10" height="10" fill="white" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button><div class="px-0.5 pt-1"><div class="song-title">${v.title}</div></div>`;
                c.appendChild(d);
            });
        }

        async function setPlayerMode(mode) {
            const curTime = currentMediaElement.currentTime;
            playerMode = mode;
            updateResolutionControl();
            document.getElementById('audioModeBtn').classList.toggle('active', mode === 'audio');
            document.getElementById('videoModeBtn').classList.toggle('active', mode === 'video');
            const isVideo = mode === 'video';
            document.getElementById('fThumb').classList.toggle('hidden', isVideo);
            document.getElementById('videoContainer').classList.toggle('hidden', !isVideo);
            if (currentIndex !== -1) { audio.pause(); video.pause(); await play(currentIndex, curTime); }
        }

        async function play(idx, startTime = 0, autoStart = true) {
            currentIndex = idx; const s = playlist[idx];
            document.getElementById('mThumb').src = document.getElementById('fThumb').src = s.thumbnail;
            document.getElementById('mTitle').innerText = document.getElementById('fTitle').innerText = s.title;
            const titleEl = document.getElementById('fTitle');
            titleEl.style.animation = 'none'; titleEl.offsetHeight; titleEl.style.animation = null;
            document.getElementById('miniPlayer').classList.remove('hidden');
            
            // Gửi activeSpeaker (target) để Python chọn định dạng phù hợp
            const r = await fetch(API_BASE+'/api/get_stream', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify({ 
                    url: s.url, 
                    mode: playerMode,
                    target: activeSpeaker,
                    resolution: videoResolution 
                }) 
            });
            const dat = await r.json();
            
            if(activeSpeaker === 'browser'){
                currentMediaElement = playerMode === 'video' ? video : audio;
                if (playerMode === 'video') audio.pause(); else video.pause();
                currentMediaElement.src = API_BASE+'/api/proxy?url='+encodeURIComponent(dat.stream_url);
                currentMediaElement.currentTime = startTime;
                if (autoStart) currentMediaElement.play().catch(e => console.log("Play error"));
                updateIcons(autoStart);
                if(autoStart) {
                    await pushRecentHistory({
                        title: s.title,
                        url: s.url,
                        source_url: s.url,
                        thumbnail: s.thumbnail,
                        mode: playerMode,
                        entity_id: activeSpeaker
                    });
                }
            } else {
                audio.pause(); video.pause();
                await fetch(API_BASE+'/api/cast', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ 
                        entity_id: activeSpeaker, 
                        url: dat.stream_url,
                        source_url: s.url,
                        title: s.title, 
                        thumbnail: s.thumbnail, // Pass metadata
                        mode: playerMode, // Pass mode
                        resolution: videoResolution,
                        seek_time: startTime 
                    }) 
                });
                updateIcons(true);
                await pushRecentHistory({
                    title: s.title,
                    url: s.url,
                    source_url: s.url,
                    thumbnail: s.thumbnail,
                    mode: playerMode,
                    entity_id: activeSpeaker
                });
            }
        }

        function updateIcons(p) { 
            const i = p ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' : '<path d="M8 5v14l11-7z"/>'; 
            document.getElementById('mPlayIcon').innerHTML = document.getElementById('fPlayIcon').innerHTML = i;
            updateQuickStatus(p ? '▶️ Đang phát' : '⏸️ Tạm dừng');
            
            const viz = document.getElementById('musicViz');
            const bg = document.getElementById('ambientBg');
            
            if(p && playerMode === 'audio') {
                viz.classList.remove('opacity-0', 'paused');
                bg.classList.add('active', 'beating'); 
            } else {
                viz.classList.add('paused'); 
                bg.classList.remove('beating'); 
            }
        }

        function togglePlay() { 
            if(activeSpeaker !== 'browser') {
                const isPaused = document.getElementById('fPlayIcon').innerHTML.includes('M8 5v14l11-7z');
                castControl(isPaused ? 'play' : 'pause');
                updateIcons(isPaused);
                return;
            }
            currentMediaElement.paused ? currentMediaElement.play() : currentMediaElement.pause(); 
            updateIcons(!currentMediaElement.paused); 
        }

        function toggleShuffle() {
            isShuffle = !isShuffle;
            document.getElementById('shuffleBtn').classList.toggle('text-red-600', isShuffle);
        }

        function next() { 
            if(isShuffle && playlist.length > 1) {
                let nextIdx;
                do { nextIdx = Math.floor(Math.random() * playlist.length); } while (nextIdx === currentIndex);
                currentIndex = nextIdx;
            } else {
                currentIndex = (currentIndex+1)%playlist.length; 
            }
            play(currentIndex); 
        }

        function prev() { currentIndex = (currentIndex-1+playlist.length)%playlist.length; play(currentIndex); }
        function seek(v) { isSeeking = true; document.getElementById('curT').innerText = fmt((v/100)*currentMediaElement.duration); }
        async function seekEnd(v) { 
            const newTime = (v/100)*currentMediaElement.duration;
            if(activeSpeaker === 'browser') { if(currentMediaElement.duration) currentMediaElement.currentTime = newTime; } 
            else { await fetch(API_BASE+'/api/seek', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ entity_id: activeSpeaker, position: newTime }) }); }
            isSeeking = false; 
        }
        function toggleRepeat() { isRepeat = !isRepeat; document.getElementById('repBtn').classList.toggle('text-red-600', isRepeat); }
        async function changeResolution(value) {
            videoResolution = value || 'auto';
            localStorage.setItem('videoResolution', videoResolution);
            videoStallCount = 0;
            updateResolutionControl();
            updateQuickStatus('🔄 Đổi độ phân giải...');
            if(playerMode !== 'video' || currentIndex < 0) {
                updateQuickStatus();
                return;
            }
            const keepTime = currentMediaElement && currentMediaElement.duration ? currentMediaElement.currentTime : 0;
            audio.pause();
            video.pause();
            await play(currentIndex, keepTime, true);
        }
        function openFullPlayer() { document.getElementById('fullPlayer').classList.add('active'); }
        function closeFullPlayer() { setVideoZoom(false); document.getElementById('fullPlayer').classList.remove('active'); }
        function toggleTheme() { document.body.classList.toggle('light-mode'); }
        function switchTab(t) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.id === 'tab-'+t));
            document.querySelectorAll('.tab-section').forEach(s => s.classList.add('hidden'));

            if(t === 'schedule') {
                document.getElementById('section-schedule')?.classList.remove('hidden');
                loadTimers();
                loadAdvancedSchedules();
                return;
            }

            document.getElementById('section-'+t)?.classList.remove('hidden');
            if(t === 'playlist') loadPlaylists();
        }
        async function createPlaylist() { const n = document.getElementById('newPlName').value; if(!n) return; await fetch(API_BASE+'/api/playlists', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: n }) }); document.getElementById('newPlName').value = ''; loadPlaylists(); }
        async function loadPlaylists() {
            const r = await fetch(API_BASE+'/api/playlists'), d = await r.json();
            document.getElementById('plList').innerHTML = Object.keys(d).map(n => `<div class="glass-card p-3 flex justify-between items-center" onclick="viewPl('${n}')"><div class="min-w-0 flex-grow"><div class="font-bold truncate text-xs">${n}</div></div><button onclick="event.stopPropagation(); delPl('${n}')" class="text-zinc-500 p-2 active:text-red-600">🗑️</button></div>`).join('');
            document.getElementById('tPlaylist').innerHTML = '<option value="">-- KHÔNG PHÁT --</option>' + Object.keys(d).map(n => `<option value="${n}">${n}</option>`).join('');
            const advPl = document.getElementById('advPlaylist');
            if(advPl) advPl.innerHTML = Object.keys(d).map(n => `<option value="${n}">${n}</option>`).join('');
        }
        async function viewPl(n) { 
            const r = await fetch(API_BASE+'/api/playlists'), d = await r.json(); playlist = d[n]; 
            const listHtml = playlist.map((s, idx) => `<div class="flex items-center gap-3 p-2.5 glass-card active:scale-[0.98]"><img src="${s.thumbnail}" class="w-8 h-8 rounded-lg object-cover"><div class="min-w-0 flex-grow" onclick="play(${idx})"><div class="text-[10px] font-bold truncate">${s.title}</div></div><button onclick="removeFromPl('${n}', ${idx})" class="shrink-0 p-2 text-zinc-500 active:text-red-600">🗑️</button></div>`).join('');
            document.getElementById('section-home').innerHTML = `<div class="col-span-2 space-y-2"><div class="flex justify-between items-center p-3 mb-1 bg-red-600/10 rounded-xl"><div class="font-black text-[10px] uppercase text-red-600">${n}</div><button onclick="performNewSearch()" class="text-[9px] font-black uppercase">ĐÓNG</button></div><div class="grid gap-2">${listHtml || 'Trống'}</div></div>`;
            switchTab('home');
        }
        async function delPl(n) { if(confirm(`Xóa playlist ${n}?`)) { await fetch(API_BASE+'/api/playlists/'+n, { method: 'DELETE' }); loadPlaylists(); } }
        async function removeFromPl(n, idx) { await fetch(API_BASE+`/api/playlists/${n}/music/${idx}`, { method: 'DELETE' }); viewPl(n); }
        function openPicker(i) { songToAdd = playlist[i]; document.getElementById('plPicker').classList.remove('hidden'); loadPicker(); }
        async function loadPicker() { const r = await fetch(API_BASE+'/api/playlists'), d = await r.json(); document.getElementById('pickerItems').innerHTML = Object.keys(d).map(n => `<button onclick="addToPl('${n}')" class="w-full p-3.5 rounded-xl text-left font-black text-xs" style="background: var(--modal-btn)">${n}</button>`).join(''); }
        async function addToPl(n) { await fetch(API_BASE+'/api/playlists/'+n+'/add', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(songToAdd) }); closePicker(); }
        function closePicker() { document.getElementById('plPicker').classList.add('hidden'); }
        function openPlaylistPicker() { songToAdd = playlist[currentIndex]; if(!songToAdd) return; document.getElementById('plPicker').classList.remove('hidden'); loadPicker(); }
        
        // Timer Logic
        function toggleDay(btn, idx) { 
            const i = currentTimerDays.indexOf(idx); 
            if (i > -1) { currentTimerDays.splice(i, 1); btn.classList.remove('active'); } 
            else { currentTimerDays.push(idx); btn.classList.add('active'); } 
        }
        function toggleTimerRandom() {
            currentTimerRandom = !currentTimerRandom;
            document.getElementById('tRandomBtn').classList.toggle('active', currentTimerRandom);
        }
        function toggleTimerFields() { 
            const t = document.getElementById('tType').value; 
            document.getElementById('tDurationContainer').classList.toggle('hidden', t === 'stop'); 
            document.getElementById('tPlaylist').classList.toggle('hidden', t === 'stop'); 
        }
        async function saveTimer() {
            const id = document.getElementById('editTimerId').value, t = document.getElementById('tTime').value; if(!t) return;
            const b = { 
                id, time: t, type: document.getElementById('tType').value, 
                entity_id: document.getElementById('tSpeaker').value, 
                duration: document.getElementById('tDuration').value, 
                playlist_name: document.getElementById('tPlaylist').value, 
                days: currentTimerDays,
                is_random: currentTimerRandom
            };
            await fetch(API_BASE+'/api/timers', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(b) }); 
            resetTimerForm(); loadTimers();
        }
        function resetTimerForm() { 
            document.getElementById('editTimerId').value = ''; 
            document.getElementById('tTime').value = ''; 
            document.getElementById('timerActionTitle').innerText = "Thiết lập hẹn giờ"; 
            document.getElementById('cancelEditBtn').classList.add('hidden'); 
            currentTimerDays = []; 
            currentTimerRandom = false;
            document.getElementById('tRandomBtn').classList.remove('active');
            document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active')); 
        }
        async function loadTimers() {
            const r = await fetch(API_BASE+'/api/timers'), d = await r.json();
            const dns = ["T2","T3","T4","T5","T6","T7","CN"];
            document.getElementById('timerDisplay').innerHTML = d.map(t => {
                const dayLabels = t.days && t.days.length ? t.days.map(x => dns[x]).join(',') : 'Mọi ngày';
                const randomTag = t.is_random ? ' <span class="text-[7px] bg-red-600 text-white px-1 rounded ml-1">RANDOM</span>' : '';
                return `<div class="glass-card p-3 flex justify-between items-center"><div class="min-w-0 pr-4 flex-grow"><div class="font-black text-sm">${t.time}</div><div class="text-[8px] font-black text-red-600 uppercase">${t.type}${randomTag} • ${dayLabels}</div></div><div class="flex gap-2"><button onclick="editTimer('${t.id}')" class="text-zinc-500 p-1.5">✏️</button><button onclick="delTimer('${t.id}')" class="text-zinc-500 p-1.5 active:text-red-600">🗑️</button></div></div>`;
            }).join('');
        }
        async function editTimer(id) {
            const r = await fetch(API_BASE+'/api/timers'), d = await r.json(), t = d.find(x => x.id === id);
            if(t) {
                document.getElementById('editTimerId').value = t.id; 
                document.getElementById('tTime').value = t.time; 
                document.getElementById('tType').value = t.type;
                document.getElementById('tSpeaker').value = t.entity_id; 
                document.getElementById('tDuration').value = t.duration || '';
                document.getElementById('tPlaylist').value = t.playlist_name || ''; 
                document.getElementById('cancelEditBtn').classList.remove('hidden'); 
                document.getElementById('timerActionTitle').innerText = "Sửa hẹn giờ";
                currentTimerRandom = t.is_random || false;
                document.getElementById('tRandomBtn').classList.toggle('active', currentTimerRandom);
                currentTimerDays = t.days || []; 
                document.querySelectorAll('.day-btn').forEach(btn => btn.classList.toggle('active', currentTimerDays.includes(parseInt(btn.dataset.day))));
                toggleTimerFields();
            }
        }
        async function delTimer(id) { if(confirm(`Xóa?`)) { await fetch(API_BASE+'/api/timers/'+id, { method: 'DELETE' }); loadTimers(); } }

        async function openDebugPanel() {
            const box = document.getElementById('debugPanel');
            box.classList.remove('hidden');
            await loadSettingsUI();
            await loadHealthDetail();
            await loadTestHistory();
            await loadRecentLogs();
            const out = document.getElementById('debugOut');
            out.textContent = 'Loading debug...';
            try {
                const r = await fetch(API_BASE + '/api/debug');
                const d = await r.json();
                out.textContent = JSON.stringify(d, null, 2);
            } catch(e) {
                out.textContent = String(e);
            }
        }

        function closeDebugPanel() {
            document.getElementById('debugPanel').classList.add('hidden');
        }

        async function loadSettingsUI() {
            try {
                const d = await fetch(API_BASE + '/api/settings').then(r => r.json());
                document.getElementById('providerInput').value = d.provider || 'youtube';
                document.getElementById('modelInput').value = d.model || 'yt-dlp-default';
            } catch(e) {}
        }

        async function saveProviderModel() {
            const body = {
                provider: document.getElementById('providerInput').value,
                model: document.getElementById('modelInput').value
            };
            await fetch(API_BASE + '/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
            await loadRecentLogs();
        }

        async function testProviderModel() {
            const body = {
                provider: document.getElementById('providerInput').value,
                model: document.getElementById('modelInput').value
            };
            const out = document.getElementById('testHistoryOut');
            out.innerHTML = '<div class="debug-row">Đang test...</div>';
            await fetch(API_BASE + '/api/test_provider', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
            await loadTestHistory();
            await loadRecentLogs();
        }

        async function loadHealthDetail() {
            const out = document.getElementById('healthOut');
            out.textContent = 'Checking...';
            try {
                const d = await fetch(API_BASE + '/api/health_detail').then(r => r.json());
                out.textContent = JSON.stringify(d, null, 2);
            } catch(e) { out.textContent = String(e); }
        }

        async function loadTestHistory() {
            const box = document.getElementById('testHistoryOut');
            try {
                const rows = await fetch(API_BASE + '/api/test_history').then(r => r.json());
                box.innerHTML = (rows || []).slice().reverse().map(x => `<div class="debug-row ${x.ok ? 'ok' : 'bad'}"><b>${x.ok ? 'OK' : 'FAIL'}</b> • ${x.time || ''}<br><span>${x.provider || ''} / ${x.model || ''} • ${x.latency_ms || 0}ms • ${x.sample_count || 0} results</span>${x.error ? `<br><span>${x.error}</span>` : ''}</div>`).join('') || '<div class="debug-row">Chưa có lịch sử test</div>';
            } catch(e) { box.innerHTML = `<div class="debug-row bad">${String(e)}</div>`; }
        }

        async function loadRecentLogs() {
            const box = document.getElementById('logsOut');
            try {
                const rows = await fetch(API_BASE + '/api/logs').then(r => r.json());
                box.innerHTML = (rows || []).slice().reverse().map(x => `<div class="debug-row"><b>${x.level || 'log'}</b> • ${x.time || ''}<br><span>${x.message || ''}</span></div>`).join('') || '<div class="debug-row">Chưa có logs</div>';
            } catch(e) { box.innerHTML = `<div class="debug-row bad">${String(e)}</div>`; }
        }

        async function clearRecentLogs() {
            await fetch(API_BASE + '/api/logs', {method:'DELETE'});
            await loadRecentLogs();
        }

        async function exportDebugBundle() {
            try {
                const d = await fetch(API_BASE + '/api/debug_bundle').then(r => r.json());
                const blob = new Blob([JSON.stringify(d, null, 2)], {type:'application/json'});
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'youtube_cast_debug_bundle_v1.20.18.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            } catch(e) { alert(String(e)); }
        }

        async function toggleWatchdogUI() {
            const cur = await fetch(API_BASE + '/api/watchdog').then(r => r.json());
            const nextEnabled = !cur.enabled;
            await fetch(API_BASE + '/api/watchdog', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({enabled: nextEnabled})
            });
            await loadHealthDetail();
        }

        async function refreshStreamUI() {
            await fetch(API_BASE + '/api/refresh_stream', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({})
            });
            await loadHealthDetail();
            await loadRecentLogs();
        }

        async function addCurrentToQueue() {
            const s = playlist[currentIndex];
            if(!s) return;
            await fetch(API_BASE + '/api/queue', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({title: s.title, url: s.url, thumbnail: s.thumbnail})
            });
            updateQuickStatus('➕ Đã thêm vào hàng chờ');
            await renderQueueList();
        }

        async function addToQueueByIndex(i) {
            const s = playlist[i];
            if(!s) return;
            await fetch(API_BASE + '/api/queue', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({title: s.title, url: s.url, thumbnail: s.thumbnail})
            });
            updateQuickStatus('➕ Đã thêm vào hàng chờ');
            await renderQueueList();
        }

        async function loadQueue() {
            try {
                return await fetch(API_BASE + '/api/queue').then(r => r.json());
            } catch(e) {
                return [];
            }
        }

        async function removeQueueItem(idx) {
            await fetch(API_BASE + '/api/queue?idx=' + encodeURIComponent(idx), {method: 'DELETE'});
            await renderQueueList();
        }

        async function playQueueItem(idx) {
            const rows = await loadQueue();
            const x = rows && rows[idx];
            if(!x) return;
            await removeQueueItem(idx);
            const nextIdx = playlist.push({title: x.title || 'Queue item', url: x.url, thumbnail: x.thumbnail || ''}) - 1;
            await play(nextIdx, 0, true);
            updateQuickStatus('▶️ Phát nhanh từ hàng chờ');
        }

        async function queueMoveUp(idx) {
            if(idx <= 0) return;
            await reorderQueueItem(idx, idx - 1);
            updateQuickStatus('⬆️ Đã đưa lên');
        }

        async function queueMoveDown(idx) {
            const rows = await loadQueue();
            if(!rows || idx >= rows.length - 1) return;
            await reorderQueueItem(idx, idx + 1);
            updateQuickStatus('⬇️ Đã đưa xuống');
        }

        async function reorderQueueItem(from, to) {
            await fetch(API_BASE + '/api/queue/reorder', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({from, to})
            });
            await renderQueueList();
        }

        async function clearQueue() {
            await fetch(API_BASE + '/api/queue', {method: 'DELETE'});
            await renderQueueList();
            updateQuickStatus('🧹 Đã xóa hàng chờ');
        }

        function scrollQueueTop() {
            const box = document.getElementById('queueList');
            if(!box) return;
            box.scrollTo({top: 0, behavior: 'smooth'});
        }

        function scrollQueueBottom() {
            const box = document.getElementById('queueList');
            if(!box) return;
            box.scrollTo({top: box.scrollHeight, behavior: 'smooth'});
        }

        async function renderQueueList() {
            const box = document.getElementById('queueList');
            if(!box) return;
            const rows = await loadQueue();
            if(!rows || rows.length === 0) {
                box.innerHTML = '<div class="text-[10px] text-zinc-500">Hàng chờ đang trống</div>';
                return;
            }
            box.innerHTML = rows.map((x, i) => `
                <div class="glass-card p-2 queue-compact-row flex items-center gap-2 queue-item" draggable="true" ondragstart="queueDragStart(event, ${i})" ondragover="queueDragOver(event)" ondrop="queueDrop(event, ${i})" ontouchstart="queueTouchStart(event)" ontouchend="queueTouchEnd(event, ${i})">
                    <div class="queue-handle">⋮⋮</div>
                    <img src="${x.thumbnail || ''}" class="w-8 h-8 rounded-lg object-cover bg-zinc-800">
                    <div class="min-w-0 flex-grow" onclick="playQueueItem(${i})">
                        <div class="text-[10px] font-bold truncate">${x.title || '...'}</div>
                    </div>
                    <div class="queue-actions-inline">
                        <button onclick="event.stopPropagation(); playQueueItem(${i})" class="queue-action-btn" title="Phát ngay">▶</button>
                        <button onclick="event.stopPropagation(); queueMoveUp(${i})" class="queue-action-btn" title="Đưa lên">↑</button>
                        <button onclick="event.stopPropagation(); queueMoveDown(${i})" class="queue-action-btn" title="Đưa xuống">↓</button>
                        <button onclick="event.stopPropagation(); removeQueueItem(${i})" class="queue-action-btn danger" title="Xóa">🗑️</button>
                    </div>
                </div>
            `).join('');
        }

        async function playNextFromQueue() {
            try {
                const r = await fetch(API_BASE + '/api/queue/pop', {method: 'POST'});
                if(!r.ok) return false;
                const d = await r.json();
                if(!d || !d.success || !d.item || !d.item.url) return false;
                const qItem = d.item;
                playlist.push({title: qItem.title || 'Queue item', url: qItem.url, thumbnail: qItem.thumbnail || ''});
                currentIndex = playlist.length - 1;
                await play(currentIndex, 0, true);
                await renderQueueList();
                updateQuickStatus('▶️ Đang phát từ hàng chờ');
                return true;
            } catch(e) {
                return false;
            }
        }

        let queueDragFrom = -1;
        let queueTouchStartX = 0;
        let queueTouchStartY = 0;
        function queueDragStart(e, idx) { queueDragFrom = idx; e.dataTransfer.effectAllowed = 'move'; }
        function queueDragOver(e) { e.preventDefault(); }
        function queueTouchStart(e) {
            const t = e.touches && e.touches[0];
            if(!t) return;
            queueTouchStartX = t.clientX;
            queueTouchStartY = t.clientY;
        }
        async function queueTouchEnd(e, idx) {
            const t = e.changedTouches && e.changedTouches[0];
            if(!t) return;
            const dx = t.clientX - queueTouchStartX;
            const dy = t.clientY - queueTouchStartY;
            if(Math.abs(dx) < 42 || Math.abs(dx) <= Math.abs(dy) * 1.15) return;
            if(dx < 0) {
                await queueMoveDown(idx);
            } else {
                await queueMoveUp(idx);
            }
        }
        async function queueDrop(e, idx) {
            e.preventDefault();
            if(queueDragFrom < 0 || queueDragFrom === idx) return;
            await reorderQueueItem(queueDragFrom, idx);
            queueDragFrom = -1;
        }

        async function setSleepTimer(minutes) {
            if(!minutes || minutes <= 0) return;
            await fetch(API_BASE + '/api/sleep_timer', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({minutes, entity_id: activeSpeaker})
            });
            updateQuickStatus(`⏳ Hẹn tắt sau ${minutes} phút`);
            await refreshSleepTimerUI();
        }

        async function cancelSleepTimer() {
            await fetch(API_BASE + '/api/sleep_timer', {method: 'DELETE'});
            updateQuickStatus('❌ Đã hủy hẹn tắt');
            await refreshSleepTimerUI();
        }

        async function setSleepTimerCustom() {
            const raw = prompt('Nhập số phút muốn hẹn tắt', '90');
            if(raw === null) return;
            const minutes = Number(raw);
            if(!Number.isFinite(minutes) || minutes <= 0) {
                toast('Số phút không hợp lệ', 'bad');
                return;
            }
            await setSleepTimer(Math.round(minutes));
        }

        async function refreshSleepTimerUI() {
            const el = document.getElementById('sleepTimerStatus');
            if(!el) return;
            try {
                const st = await fetch(API_BASE + '/api/sleep_timer').then(r => r.json());
                if(st && st.enabled) {
                    const sec = Number(st.remaining_sec || 0);
                    const m = Math.floor(sec / 60);
                    const s = sec % 60;
                    el.textContent = `Đang bật • còn ${m}:${s < 10 ? '0' : ''}${s}`;
                    el.classList.add('text-red-600');
                } else {
                    el.textContent = 'Chưa bật hẹn tắt';
                    el.classList.remove('text-red-600');
                }
            } catch(e) {
                el.textContent = 'Không đọc được trạng thái sleep timer';
            }
        }

        function startSleepTimerTicker() {
            setInterval(refreshSleepTimerUI, 5000);
        }

        async function pushRecentHistory(item) {
            try {
                await fetch(API_BASE + '/api/recent_history', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(item || {})
                });
                await renderRecentHistory();
            } catch(e) {}
        }

        async function loadRecentHistory() {
            try {
                return await fetch(API_BASE + '/api/recent_history').then(r => r.json());
            } catch(e) {
                return [];
            }
        }

        async function clearRecentHistory() {
            await fetch(API_BASE + '/api/recent_history', {method: 'DELETE'});
            await renderRecentHistory();
            updateQuickStatus('🧹 Đã xóa lịch sử gần đây');
        }

        async function playFromRecent(url) {
            const rows = await loadRecentHistory();
            const x = (rows || []).find(i => i.url === url);
            if(!x) return;
            const idx = playlist.push({title: x.title || 'History', url: x.url, thumbnail: x.thumbnail || ''}) - 1;
            await play(idx, 0, true);
            updateQuickStatus('🕘 Phát từ lịch sử gần đây');
        }

        async function addRecentToQueue(url) {
            const rows = await loadRecentHistory();
            const x = (rows || []).find(i => i.url === url);
            if(!x) return;
            await fetch(API_BASE + '/api/queue', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({title: x.title || 'History', url: x.url, thumbnail: x.thumbnail || ''})
            });
            await renderQueueList();
            updateQuickStatus('➕ Đã thêm từ lịch sử vào hàng chờ');
        }

        async function renderRecentHistory() {
            const box = document.getElementById('recentHistoryList');
            if(!box) return;
            const rows = await loadRecentHistory();
            const rev = (rows || []).slice().reverse().slice(0, 12);
            if(!rev.length) {
                box.innerHTML = '<div class="text-[10px] text-zinc-500">Chưa có lịch sử</div>';
                return;
            }
            box.innerHTML = rev.map(x => `
                <div class="glass-card p-2 recent-compact-row flex items-center gap-2">
                    <img src="${x.thumbnail || ''}" class="w-8 h-8 rounded-lg object-cover bg-zinc-800">
                    <div class="min-w-0 flex-grow" onclick="playFromRecent('${(x.url||'').replace(/'/g, "\\'")}')">
                        <div class="text-[10px] font-bold truncate">${x.title || '...'}</div>
                        <div class="recent-meta text-[8px] text-zinc-500">${x.played_at || ''}</div>
                    </div>
                    <div class="queue-actions-inline">
                        <button onclick="event.stopPropagation(); playFromRecent('${(x.url||'').replace(/'/g, "\\'")}')" class="queue-action-btn" title="Phát lại">▶</button>
                        <button onclick="event.stopPropagation(); addRecentToQueue('${(x.url||'').replace(/'/g, "\\'")}')" class="queue-action-btn" title="Thêm vào hàng chờ">＋</button>
                    </div>
                </div>
            `).join('');
        }

        async function loadPresets() {
            try {
                return await fetch(API_BASE + '/api/presets').then(r => r.json());
            } catch(e) {
                return [];
            }
        }

        async function saveCurrentPreset() {
            const s = playlist[currentIndex];
            if(!s) return;
            const n = prompt('Tên preset nhanh:', (s.title || '').slice(0, 30));
            if(!n) return;
            const g = prompt('Nhóm preset / phòng / gói nhạc:', localStorage.getItem('lastPresetGroup') || 'Mặc định') || 'Mặc định';
            localStorage.setItem('lastPresetGroup', g);
            await apiJson(API_BASE + '/api/presets', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    name: n,
                    group: g,
                    title: s.title,
                    url: s.url,
                    source_url: s.url,
                    thumbnail: s.thumbnail,
                    entity_id: activeSpeaker,
                    mode: playerMode,
                    resolution: videoResolution
                })
            });
            await renderPresets();
            updateQuickStatus('⭐ Đã lưu preset 1 chạm');
            toast('Đã lưu preset', 'ok');
        }

        async function removePreset(id) {
            await apiJson(API_BASE + '/api/presets?id=' + encodeURIComponent(id), {method: 'DELETE'});
            await renderPresets();
            toast('Đã xóa preset', 'ok');
        }

        async function duplicatePreset(id) {
            await apiJson(API_BASE + '/api/presets/' + encodeURIComponent(id) + '/duplicate', {method: 'POST'});
            await renderPresets();
            toast('Đã nhân bản preset', 'ok');
        }

        async function editPreset(id) {
            const rows = await loadPresets();
            const p = (rows || []).find(x => x.id === id);
            if(!p) return;
            const name = prompt('Sửa tên preset:', p.name || p.title || 'Preset');
            if(!name) return;
            const group = prompt('Sửa nhóm preset:', p.group || 'Mặc định') || 'Mặc định';
            await apiJson(API_BASE + '/api/presets', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({...p, name, group, id: p.id})
            });
            await renderPresets();
            toast('Đã cập nhật preset', 'ok');
        }

        async function playPreset(id) {
            const rows = await loadPresets();
            const p = (rows || []).find(x => x.id === id);
            if(!p) return;
            if(p.entity_id) {
                activeSpeaker = p.entity_id;
                const sl = document.getElementById('speakerList');
                if(sl) sl.value = activeSpeaker;
            }
            if(p.mode) {
                playerMode = p.mode;
                updateResolutionControl();
                document.getElementById('audioModeBtn').classList.toggle('active', p.mode === 'audio');
                document.getElementById('videoModeBtn').classList.toggle('active', p.mode === 'video');
                document.getElementById('fThumb').classList.toggle('hidden', p.mode === 'video');
                document.getElementById('videoContainer').classList.toggle('hidden', p.mode !== 'video');
            }
            if(p.resolution) {
                videoResolution = p.resolution;
                const rs = document.getElementById('resolutionSelect');
                if(rs) rs.value = videoResolution;
            }
            const idx = playlist.push({title: p.title || p.name || 'Preset', url: p.url, thumbnail: p.thumbnail || ''}) - 1;
            await play(idx, 0, true);
            updateQuickStatus('⚡ Đang phát preset 1 chạm');
            toast('Đang phát preset', 'ok');
        }

        async function renderPresets() {
            const box = document.getElementById('presetList');
            if(!box) return;
            const rows = await loadPresets();
            const filter = document.getElementById('presetGroupFilter');
            const groups = [...new Set((rows || []).map(x => x.group || 'Mặc định'))];
            if(filter) {
                const cur = filter.value || 'all';
                filter.innerHTML = '<option value="all">Tất cả nhóm</option>' + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
                filter.value = groups.includes(cur) ? cur : 'all';
            }
            const visible = (rows || []).filter(x => !filter || filter.value === 'all' || (x.group || 'Mặc định') === filter.value);
            if(!visible.length) {
                box.innerHTML = '<div class="text-[10px] text-zinc-500">Chưa có preset</div>';
                return;
            }
            box.innerHTML = visible.slice().reverse().map(x => `
                <div class="pretty-row preset-row">
                    <img src="${esc(x.thumbnail || '')}" class="pretty-thumb">
                    <div class="min-w-0 flex-grow" onclick="playPreset('${x.id}')">
                        <div class="text-[10px] font-bold truncate">${esc(x.name || x.title || 'Preset')}</div>
                        <div class="text-[8px] text-zinc-500 truncate">${esc(x.group || 'Mặc định')} • ${esc(x.mode || 'audio')} • ${esc(x.entity_id || 'browser')}</div>
                    </div>
                    <div class="row-actions">
                        <button onclick="event.stopPropagation(); editPreset('${x.id}')" class="icon-btn">✏️</button>
                        <button onclick="event.stopPropagation(); duplicatePreset('${x.id}')" class="icon-btn">⧉</button>
                        <button onclick="event.stopPropagation(); removePreset('${x.id}')" class="icon-btn danger">🗑️</button>
                    </div>
                </div>
            `).join('');
        }

        function toggleAdvDay(btn, idx) {
            const i = advancedDays.indexOf(idx);
            if(i > -1) { advancedDays.splice(i, 1); btn.classList.remove('active'); }
            else { advancedDays.push(idx); btn.classList.add('active'); }
        }

        function resetAdvancedScheduleForm() {
            advancedEditId = '';
            advancedEditEnabled = true;
            advancedDays = [];
            document.getElementById('advEditId').value = '';
            document.getElementById('advFormTitle').innerText = 'Lịch phát nâng cao';
            document.getElementById('advCancelBtn').classList.add('hidden');
            document.getElementById('advName').value = '';
            document.getElementById('advAt').value = '';
            document.querySelectorAll('#advDays .day-btn').forEach(b => b.classList.remove('active'));
        }

        async function saveAdvancedSchedule(btn) {
            const name = document.getElementById('advName').value || 'Lịch nâng cao';
            const at = document.getElementById('advAt').value;
            const entity_id = document.getElementById('advSpeaker').value;
            const playlist_name = document.getElementById('advPlaylist').value;
            if(!at || !entity_id || !playlist_name) { toast('Nhập đủ giờ, loa và playlist', 'bad'); return; }
            try {
                setBtnLoading(btn, true);
                await apiJson(API_BASE + '/api/schedule_rules', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({id: advancedEditId || undefined, name, at, entity_id, playlist_name, days: advancedDays, enabled: advancedEditEnabled, is_random: true})
                });
                resetAdvancedScheduleForm();
                await loadAdvancedSchedules();
                updateQuickStatus('📅 Đã lưu lịch nâng cao');
                toast('Đã lưu lịch nâng cao', 'ok');
            } catch(e) {
                toast('Lưu lịch thất bại: ' + e.message, 'bad');
            } finally {
                setBtnLoading(btn, false, 'LƯU LỊCH NÂNG CAO');
            }
        }

        async function editAdvancedSchedule(id) {
            const rows = await apiJson(API_BASE + '/api/schedule_rules');
            const r = (rows || []).find(x => x.id === id);
            if(!r) return;
            advancedEditId = r.id;
            advancedEditEnabled = !!r.enabled;
            advancedDays = Array.isArray(r.days) ? r.days.slice() : [];
            document.getElementById('advEditId').value = r.id;
            document.getElementById('advFormTitle').innerText = 'Sửa lịch nâng cao';
            document.getElementById('advCancelBtn').classList.remove('hidden');
            document.getElementById('advName').value = r.name || '';
            document.getElementById('advAt').value = r.at || '';
            document.getElementById('advSpeaker').value = r.entity_id || '';
            document.getElementById('advPlaylist').value = r.playlist_name || '';
            document.querySelectorAll('#advDays .day-btn').forEach(btn => btn.classList.toggle('active', advancedDays.includes(parseInt(btn.dataset.day))));
            toast('Đang sửa lịch', 'info');
        }

        async function toggleAdvancedSchedule(id, enabled) {
            await apiJson(API_BASE + '/api/schedule_rules/' + encodeURIComponent(id) + '/toggle', {
                method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({enabled})
            });
            await loadAdvancedSchedules();
            toast(enabled ? 'Đã bật lịch' : 'Đã tắt lịch', 'ok');
        }

        async function duplicateAdvancedSchedule(id) {
            await apiJson(API_BASE + '/api/schedule_rules/' + encodeURIComponent(id) + '/duplicate', {method:'POST'});
            await loadAdvancedSchedules();
            toast('Đã nhân bản lịch', 'ok');
        }

        async function runAdvancedScheduleNow(id) {
            try {
                await apiJson(API_BASE + '/api/schedule_rules/' + encodeURIComponent(id) + '/run', {method:'POST'});
                toast('Đã chạy lịch ngay', 'ok');
            } catch(e) {
                toast('Run now thất bại: ' + e.message, 'bad');
            }
        }

        async function loadAdvancedSchedules() {
            const box = document.getElementById('advancedScheduleList');
            if(!box) return;
            await loadPlaylists();
            try {
                const rows = await apiJson(API_BASE + '/api/schedule_rules');
                const dns = ['T2','T3','T4','T5','T6','T7','CN'];
                if(!rows || !rows.length) { box.innerHTML = '<div class="text-[10px] text-zinc-500">Chưa có lịch nâng cao</div>'; return; }
                box.innerHTML = rows.slice().reverse().map(r => {
                    const days = (r.days && r.days.length) ? r.days.map(d=>dns[d]).join(', ') : 'Mọi ngày';
                    const en = !!r.enabled;
                    const next = r.next_run ? r.next_run.replace('T',' ') : 'Không xác định';
                    return `<div class="pretty-row adv-row ${en ? '' : 'is-off'}">
                        <div class="min-w-0 flex-grow">
                            <div class="text-xs font-black truncate">${esc(r.name || 'Lịch nâng cao')} • ${esc(r.at || '')}</div>
                            <div class="text-[9px] text-zinc-500 truncate">${esc(r.playlist_name || '')} • ${esc(r.entity_id || '')} • ${esc(days)}</div>
                            <div class="text-[8px] ${en ? 'text-emerald-500' : 'text-zinc-500'}">${en ? 'Đang bật' : 'Đang tắt'} • Lần chạy kế: ${esc(next)}</div>
                        </div>
                        <div class="row-actions wrap">
                            <button onclick="toggleAdvancedSchedule('${r.id}', ${!en})" class="icon-btn">${en ? '⏸️' : '▶️'}</button>
                            <button onclick="runAdvancedScheduleNow('${r.id}')" class="icon-btn">⚡</button>
                            <button onclick="editAdvancedSchedule('${r.id}')" class="icon-btn">✏️</button>
                            <button onclick="duplicateAdvancedSchedule('${r.id}')" class="icon-btn">⧉</button>
                            <button onclick="deleteAdvancedSchedule('${r.id}')" class="icon-btn danger">🗑️</button>
                        </div>
                    </div>`;
                }).join('');
            } catch(e) { box.innerHTML = `<div class="text-[10px] text-red-600">${String(e)}</div>`; }
        }

        async function deleteAdvancedSchedule(id) {
            await apiJson(API_BASE + '/api/schedule_rules/' + encodeURIComponent(id), {method:'DELETE'});
            await loadAdvancedSchedules();
            toast('Đã xóa lịch', 'ok');
        }

window.onload = init;
