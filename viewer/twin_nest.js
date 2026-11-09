/*
 * twin_nest.js — parts library → automatic nesting → G-code → router, inside the /v2 twin.
 *
 *   Parts library (/api/parts): modeled sketch panels (saved from the modeling window, or
 *     automatically when a part is placed in the factory) and DXF imports. Survives reloads.
 *   Nesting window: pick thickness → tick parts / set quantities → nesting + G-code are
 *     recomputed automatically → preview / download .nc (file only) / send to the router.
 *   Router: sheet lowered → clamps + vacuum → the tool replays the parsed G-code (cut groove drawn)
 *     → clamps open → cut parts come out in front of the machine.
 *
 * Depends on: Nesting, NcProgram, DxfImport, SketchCore, TwinRuntime (lib), editor_v2 globals
 * (THREE, scene, placedObjects, ASSET_CATALOG, log, cadSketch* state) and twin_live.js hooks.
 * Feeds, speeds and tab sizes are assumed placeholders. G-code is a draft — never sent to a machine.
 */
(function () {
  'use strict';
  if (typeof Nesting === 'undefined' || typeof NcProgram === 'undefined' || typeof THREE === 'undefined') return;

  let seq = 1, last = null, library = [];
  const sel = new Map();               // part id -> quantity (ticked parts)
  const jobVis = new Map();            // job id -> visuals on the router
  const geoCache = new Map();          // part id -> centred BufferGeometry
  const partMat = new THREE.MeshStandardMaterial({ color: 0xe7e2d6, roughness: 0.55, metalness: 0.05 });

  const routers = () => placedObjects.filter(o => TwinRuntime.MACHINE_KINDS[o.userData.assetId] === 'router' && o.userData.rig);
  const $ = id => document.getElementById(id);
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  const fmtS = s => { s = Math.round(s); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------ library
  async function loadLibrary() {
    try { library = (await (await fetch('/api/parts')).json()).parts || []; } catch (e) { library = []; }
    return library;
  }
  async function savePart(p) {
    const r = await fetch('/api/parts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  }
  async function deletePart(id) {
    await fetch('/api/parts?id=' + encodeURIComponent(id), { method: 'DELETE' });
    sel.delete(id);
    await loadLibrary(); renderLibrary(); schedule();
  }
  function sizeOf(p) { const c = Nesting.centrePart(p.vertices, p.holes); return `${Math.round(c.w)}×${Math.round(c.h)}`; }

  /** Save the current sketch of the modeling window. */
  async function saveCurrentSketch(name, quiet) {
    const t = SketchCore.validateThickness(cadSketchExtrudeThickness);
    if (!t.ok) throw new Error(t.error);
    const holes = cadSketchHoles.filter(h => h.isSubtract);
    for (let i = 0; i < holes.length; i++) {
      const v = SketchCore.validateHole(cadSketchVertices, holes[i], holes.slice(0, i));
      if (!v.ok) throw new Error(`구멍 #${i + 1}: ${v.error}`);
    }
    const xs = cadSketchVertices.map(p => p.x), ys = cadSketchVertices.map(p => p.y);
    const auto = `판재 ${Math.round(Math.max(...xs) - Math.min(...xs))}×${Math.round(Math.max(...ys) - Math.min(...ys))}×${t.value}`;
    const r = await savePart({ name: (name || '').trim() || auto, thickness: t.value, vertices: cadSketchVertices.map(p => ({ x: +p.x, y: +p.y })), holes: holes.map(h => ({ x: +h.x, y: +h.y, dia: +h.dia })), source: 'sketch' });
    if (!quiet) log(`📚 [라이브러리] '${r.part.name}' ${r.existing ? '(이미 저장된 형상)' : '저장됨'}`);
    await loadLibrary();
    return r;
  }

  // ------------------------------------------------------------------ generate (automatic)
  let timer = 0;
  function schedule() { clearTimeout(timer); timer = setTimeout(generate, 250); }

  function generate() {
    const thk = parseFloat($('tn-thk').value);
    const picked = [];
    library.filter(p => p.thickness === thk).forEach(p => { const q = sel.get(p.id) || 0; for (let k = 0; k < q; k++) picked.push(p); });
    if (!picked.length) { last = null; drawPreview(); $('tn-code').value = ''; $('tn-send').disabled = $('tn-dl').disabled = true; return msg('부품을 체크하면 자동으로 네스팅됩니다.'); }
    const opts = {
      sheetL: num('tn-L', 2440), sheetW: num('tn-W', 1220), marginMm: num('tn-m', 15),
      spacingMm: Math.max(num('tn-s', 12), num('tn-d', 6) + 2), allowRotate: $('tn-rot').checked,
      tool: { dia: num('tn-d', 6), stepDown: num('tn-sd', 4), feed: num('tn-f', 3000) },
      tabs: { count: num('tn-tc', 4), width: num('tn-tw', 8), height: num('tn-th', 2) }
    };
    const items = picked.map((p, i) => { const c = Nesting.centrePart(p.vertices, p.holes); return { id: `${p.name}#${i + 1}`, w: c.w, h: c.h, rec: p, centred: c }; });
    const res = Nesting.nest(items.map(it => ({ id: it.id, w: it.w, h: it.h })), opts);
    const placedParts = res.placements.map(pl => { const it = items.find(x => x.id === pl.id); const g = Nesting.placeGeometry(it.centred, pl); return { id: pl.id, outline: g.outline, holes: g.holes }; });
    const name = `SUGARHILL NEST ${String(seq).padStart(3, '0')}`;
    const gen = NcProgram.generate(placedParts, { name, sheetL: opts.sheetL, sheetW: opts.sheetW, thickness: thk, tool: opts.tool, tabs: opts.tabs });
    const prog = NcProgram.load(gen.text);
    last = { items, res, gen, prog, opts, thickness: thk, name };
    drawPreview();
    $('tn-code').value = gen.text.split('\n').slice(0, 400).join('\n') + (prog.lines > 400 ? `\n... (${prog.lines} lines total)` : '');
    const warn = res.unplaced.length ? ` · ⚠ 원판에 못 들어간 부품 ${res.unplaced.length}개` : '';
    msg(`자동 계산 · ${res.placements.length}개 배치 · 사용률 ${(res.utilization * 100).toFixed(1)}% · 절삭 ${(prog.cutLenMm / 1000).toFixed(1)} m · 예상 ${fmtS(prog.totalS)} · ${prog.lines}줄${warn}` +
      (gen.warnings.length ? ` · 경고: ${gen.warnings.join(' / ')}` : ''), !!res.unplaced.length || !!gen.warnings.length);
    $('tn-send').disabled = !res.placements.length || !routers().length;
    $('tn-dl').disabled = false;
  }

  // ------------------------------------------------------------------ preview canvas
  function drawPreview() {
    const cv = $('tn-cv'), ctx = cv.getContext('2d');
    const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, W, H);
    if (!last) return;
    const { opts, res, items, gen, prog } = last;
    const s = Math.min((W - 20) / opts.sheetL, (H - 20) / opts.sheetW), ox = (W - opts.sheetL * s) / 2, oy = (H + opts.sheetW * s) / 2;
    const P = (x, y) => [ox + x * s, oy - y * s];
    ctx.fillStyle = '#e7e2d6'; ctx.fillRect(ox, oy - opts.sheetW * s, opts.sheetL * s, opts.sheetW * s);
    ctx.strokeStyle = '#94a3b8'; ctx.setLineDash([4, 4]);
    ctx.strokeRect(ox + opts.marginMm * s, oy - (opts.sheetW - opts.marginMm) * s, (opts.sheetL - 2 * opts.marginMm) * s, (opts.sheetW - 2 * opts.marginMm) * s);
    ctx.setLineDash([]);
    res.placements.forEach(pl => {
      const it = items.find(x => x.id === pl.id), g = Nesting.placeGeometry(it.centred, pl);
      ctx.beginPath(); g.outline.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(p.x, p.y))); ctx.closePath();
      ctx.fillStyle = 'rgba(56,189,248,.28)'; ctx.fill(); ctx.strokeStyle = '#0369a1'; ctx.lineWidth = 1.2; ctx.stroke();
      g.holes.forEach(h => { ctx.beginPath(); ctx.arc(...P(h.x, h.y), h.dia / 2 * s, 0, Math.PI * 2); ctx.fillStyle = '#e7e2d6'; ctx.fill(); ctx.stroke(); });
    });
    ctx.strokeStyle = 'rgba(15,23,42,.7)'; ctx.lineWidth = 0.8; ctx.beginPath();
    prog.segs.forEach(sg => { if (!sg.rapid && Math.min(sg.z0, sg.z1) < 0) { ctx.moveTo(...P(sg.x0, sg.y0)); ctx.lineTo(...P(sg.x1, sg.y1)); } });
    ctx.stroke();
    ctx.fillStyle = '#ef4444';
    gen.tabs.forEach(t => {
      const pts = t.loop.concat([t.loop[0]]);
      t.windows.forEach(w => {
        let acc = 0; const c = (w[0] + w[1]) / 2;
        for (let i = 1; i < pts.length; i++) {
          const L = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
          if (acc + L >= c) { const u = (c - acc) / L; const [x, y] = P(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u); ctx.fillRect(x - 2.5, y - 2.5, 5, 5); break; }
          acc += L;
        }
      });
    });
  }

  // ------------------------------------------------------------------ send / download / DXF
  function download() {
    if (!last) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([last.gen.text], { type: 'text/plain' }));
    a.download = `${last.name.replace(/\s+/g, '_')}.nc`;
    a.click();
    log(`💾 [G-code] ${a.download} 저장 (초안 — 기계 투입 전 시뮬레이션·사람 검토 필수)`);
  }

  function send() {
    if (!last) return;
    const rName = $('tn-router').value;
    const part = { name: last.name, shape: 'sheet', thicknessMm: last.thickness, bboxMm: [last.opts.sheetL, last.opts.sheetW, last.thickness], count: last.res.placements.length };
    let job;
    try { job = window.twinRuntime.assignProgram(rName, part, last.prog.totalS); }
    catch (e) { return msg(e.message, true); }
    job.prog = last.prog; job.nest = last;
    seq++;
    log(`🏭 [네스팅] ${last.name} → ${rName} 작업 #${job.id} (${part.count}개 부품, NC ${last.prog.lines}줄, 예상 ${fmtS(last.prog.totalS)})`);
    close();
    if (window.twinFocusMachine) setTimeout(() => window.twinFocusMachine(rName), 50);
    schedule();                                            // next program number in the window
  }

  async function importDxf(file) {
    const text = await file.text();
    const base = file.name.replace(/\.dxf$/i, '');
    const r = DxfImport.parse(text, base);
    const thk = num('tn-dxf-t', 12);
    let added = 0;
    for (const p of r.parts) {
      try { const s = await savePart({ name: p.name, thickness: thk, vertices: p.vertices, holes: p.holes, source: 'dxf' }); sel.set(s.part.id, 1); added++; }
      catch (e) { r.warnings.push(`${p.name}: ${e.message}`); }
    }
    await loadLibrary();
    $('tn-thk').value = String(thk); fillThickness(thk);
    renderLibrary(); schedule();
    log(`📥 [DXF] ${file.name}: 부품 ${added}개 추가 (${r.units}${r.units === 'inch' ? ' → mm 변환' : ''})${r.warnings.length ? ' · ' + r.warnings.join(' / ') : ''}`);
    if (r.warnings.length) setTimeout(() => msg(r.warnings.join(' / '), true), 300);
  }

  // ------------------------------------------------------------------ router visuals
  function partGeometry(rec) {
    if (geoCache.has(rec.id)) return geoCache.get(rec.id);
    const c = Nesting.centrePart(rec.vertices, rec.holes);
    const g = SketchCore.buildPanelGeometry(THREE, c.outline, c.holes.map(h => Object.assign({ isSubtract: true }, h)), rec.thickness).geometry;
    g.translate(0, 0, -rec.thickness / 2);
    geoCache.set(rec.id, g);
    return g;
  }

  function buildVis(machineObj, job) {
    const rig = machineObj.userData.rig, n = job.nest, L = n.opts.sheetL, Wd = n.opts.sheetW, t = n.thickness;
    const g = new THREE.Group(); machineObj.add(g);
    const sheet = new THREE.Mesh(new THREE.BoxGeometry(L, Wd, t), new THREE.MeshStandardMaterial({ color: 0xe7e2d6, roughness: 0.6, metalness: 0.05, transparent: true, opacity: 1 }));
    sheet.castShadow = sheet.receiveShadow = true;
    g.add(sheet);
    const clampMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4, metalness: 0.6 });
    const clamps = [];
    [-0.35, 0.35].forEach(fx => [-1, 1].forEach(side => {
      const c = new THREE.Mesh(new THREE.BoxGeometry(120, 90, 40), clampMat);
      c.userData = { home: side * (Wd / 2 + 160), closed: side * (Wd / 2 + 10) };
      c.position.set(fx * L, c.userData.home, rig.tableZ + t + 20);
      g.add(c); clamps.push(c);
    }));
    const cutSegs = [], upto = new Int32Array(job.prog.segs.length + 1);
    job.prog.segs.forEach((sg, i) => {
      if (!sg.rapid && Math.min(sg.z0, sg.z1) < 0 && (sg.x0 !== sg.x1 || sg.y0 !== sg.y1)) cutSegs.push(sg);
      upto[i + 1] = cutSegs.length;
    });
    const pos = new Float32Array(cutSegs.length * 6);
    cutSegs.forEach((sg, k) => pos.set([-L / 2 + sg.x0, -Wd / 2 + sg.y0, 0, -L / 2 + sg.x1, -Wd / 2 + sg.y1, 0], k * 6));
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setDrawRange(0, 0);
    const trail = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x1f2937 }));
    trail.position.z = rig.tableZ + t + 0.8;
    g.add(trail);
    const v = { g, sheet, clamps, trail, upto, parts: [], L, Wd, t, rig, machineObj, job };
    jobVis.set(job.id, v);
    return v;
  }

  function spawnCutParts(v, job) {
    job.nest.res.placements.forEach(pl => {
      const it = job.nest.items.find(x => x.id === pl.id);
      const m = new THREE.Mesh(partGeometry(it.rec), partMat);
      m.castShadow = true;
      m.rotation.z = pl.rot * Math.PI / 180;
      m.position.set(-v.L / 2 + pl.cx, -v.Wd / 2 + pl.cy, v.rig.tableZ + v.t / 2);
      m.userData = { isFinishedPart: true, part: it.rec.name, partId: it.rec.id, nestId: pl.id };
      v.g.add(m); v.parts.push(m);
    });
  }

  /** Called by twin_live for router jobs that carry an NC program. Returns axis signals. */
  function drive(a, m, job) {
    const mm = window.twinRuntime.machines.get(m.name);
    const v = jobVis.get(job.id) || buildVis(a.obj, job);
    const rig = v.rig, top = rig.tableZ + v.t;
    let ax;
    if (m.phase === 'LOADING') {
      const u = Math.min(1, mm.phaseT / job.est.loadS);
      v.sheet.position.set(0, 0, top - v.t / 2 + 700 * Math.max(0, 1 - u / 0.6));
      const cu = Math.max(0, (u - 0.6) / 0.4);
      v.clamps.forEach(c => { c.position.y = c.userData.home + (c.userData.closed - c.userData.home) * cu; });
      rig.gantry.position.x = -v.L / 2 - rig.toolOffsetX; rig.carriage.position.y = -v.Wd / 2; rig.spindle.position.z = top + 25 - rig.toolTipZ;
      ax = { axis_x_mm: 0, axis_y_mm: 0, axis_z_mm: 25, spindle_rpm: 0, vacuum_on: u > 0.6, clamps_closed: cu >= 1, line: 0, program: job.nest.name };
    } else if (m.phase === 'RUNNING' || m.phase === 'HOLD') {
      v.sheet.position.set(0, 0, top - v.t / 2);
      v.clamps.forEach(c => { c.position.y = c.userData.closed; });
      const p = NcProgram.axesAt(job.prog, job.progress * job.prog.totalS);
      rig.gantry.position.x = -v.L / 2 + p.axis_x_mm - rig.toolOffsetX;
      rig.carriage.position.y = -v.Wd / 2 + p.axis_y_mm;
      rig.spindle.position.z = top + p.axis_z_mm - rig.toolTipZ;
      v.trail.geometry.setDrawRange(0, v.upto[p.seg + 1] * 2);
      a.tip.visible = m.phase === 'RUNNING' && p.axis_z_mm < 0;
      ax = Object.assign(p, { spindle_rpm: m.phase === 'HOLD' ? 0 : p.spindle_rpm, vacuum_on: true, clamps_closed: true, program: job.nest.name });
    } else {
      const u = Math.min(1, mm.phaseT / job.est.unloadS);
      v.trail.geometry.setDrawRange(0, v.upto[v.upto.length - 1] * 2);
      a.tip.visible = false;
      const cu = Math.min(1, u / 0.3);
      v.clamps.forEach(c => { c.position.y = c.userData.closed + (c.userData.home - c.userData.closed) * cu; });
      if (u > 0.3 && !v.parts.length) { spawnCutParts(v, job); v.sheet.material.opacity = 0.35; }
      v.parts.forEach(pm => { pm.position.z = top - v.t / 2 + 160 * Math.max(0, (u - 0.3) / 0.7); });
      rig.gantry.position.x = -rig.toolOffsetX; rig.carriage.position.y = 0; rig.spindle.position.z = top + 25 - rig.toolTipZ;
      ax = { axis_x_mm: 0, axis_y_mm: 0, axis_z_mm: 25, spindle_rpm: 0, vacuum_on: false, clamps_closed: cu < 1, line: 0, program: job.nest.name };
    }
    return ax;
  }

  function onEvent(e) {
    if (e.type !== 'JOB_DONE') return;
    const v = jobVis.get(e.job); if (!v) return;
    if (!v.parts.length) spawnCutParts(v, v.job);          // at very high sim speed the unloading frames can be skipped
    const D = (ASSET_CATALOG.find(x => x.assetId === v.machineObj.userData.assetId) || { dims: [0, 2100] }).dims[1];
    v.parts.forEach((pm, i) => {
      const wp = v.machineObj.localToWorld(new THREE.Vector3(-900 + (i % 4) * 600, -(D / 2 + 700 + Math.floor(i / 4) * 450), v.t / 2));
      const q = new THREE.Quaternion(); pm.getWorldQuaternion(q);
      v.g.remove(pm); scene.add(pm);
      pm.position.copy(wp); pm.quaternion.copy(q);
      pm.userData.processedBy = v.machineObj.name; pm.userData.processedAt = new Date().toISOString();
    });
    v.machineObj.remove(v.g);
    jobVis.delete(e.job);
    log(`✅ [네스팅] 작업 #${e.job} 완료 — 부품 ${v.parts.length}개 배출 (${v.machineObj.name} 앞)`);
  }

  // ------------------------------------------------------------------ window UI
  const CSS = `
  #tn{position:fixed;inset:5vh 4vw;z-index:2000;display:none;flex-direction:column;background:rgba(10,14,21,.97);border:1px solid #233047;border-radius:14px;
      color:#e2e8f0;font:12px/1.45 system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)}
  #tn *{box-sizing:border-box}
  #tn .hd{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #1e293b}#tn .hd b{font-size:14px}
  #tn .chip{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid rgba(245,158,11,.45);color:#f59e0b}
  #tn .body{flex:1;display:grid;grid-template-columns:320px minmax(0,1fr);min-height:0}
  #tn .side{border-right:1px solid #1e293b;padding:12px 14px;overflow:auto}
  #tn .main{display:grid;grid-template-rows:minmax(0,1.3fr) auto minmax(0,1fr);gap:8px;padding:12px 14px;min-height:0}
  #tn .sec{display:flex;align-items:center;gap:6px;color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin:12px 0 6px}
  #tn .sec .sp{flex:1}
  #tn .g2{display:grid;grid-template-columns:1fr 1fr;gap:6px}#tn .g3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  #tn label.l{display:block;color:#64748b;font-size:10px;margin-bottom:2px}
  #tn input,#tn select,#tn button,#tn textarea{font:inherit;color:#e2e8f0;background:#141c2b;border:1px solid #273449;border-radius:6px;padding:4px 7px}
  #tn input,#tn select{width:100%}#tn input[type=checkbox]{width:auto}
  #tn button{cursor:pointer;white-space:nowrap}#tn button:hover:not(:disabled){border-color:#38bdf8}#tn button:disabled{opacity:.45;cursor:default}
  #tn button.pri{background:#0369a1;border-color:#0284c7;color:#fff;font-weight:600}#tn button.sm{padding:1px 6px;font-size:11px}
  #tn .lib{display:flex;flex-direction:column;gap:2px;max-height:34vh;overflow:auto;border:1px solid #1e293b;border-radius:8px;padding:4px}
  #tn .item{display:grid;grid-template-columns:auto 1fr 52px auto;gap:6px;align-items:center;padding:5px 6px;border-radius:6px}
  #tn .item:hover{background:#111a28}#tn .item.on{background:rgba(56,189,248,.08)}
  #tn .item small{display:block;color:#64748b}#tn .src{font-size:9px;border:1px solid #273449;border-radius:4px;padding:0 4px;color:#94a3b8;margin-left:4px}
  #tn .empty{color:#64748b;padding:8px}
  #tn canvas{width:100%;height:100%;background:#0e141f;border:1px solid #1e293b;border-radius:10px;min-height:180px}
  #tn textarea{width:100%;height:100%;resize:none;font:11px/1.35 ui-monospace,Consolas,monospace;color:#cbd5e1;background:#0e141f}
  #tn .bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  #tn .msg{flex:1;min-width:200px;color:#94a3b8}#tn .msg.err{color:#fca5a5}
  #tn .legend{display:flex;gap:12px;color:#64748b;font-size:11px}#tn .legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
  @media (max-width:860px){#tn{inset:8px}#tn .body{grid-template-columns:1fr}#tn .side{border-right:0;border-bottom:1px solid #1e293b;max-height:45vh}}
  .tn-save{display:flex;gap:6px;margin-top:8px}.tn-save input{flex:1;min-width:0;background:#0c1017;border:1px solid #233047;color:#e2e8f0;border-radius:4px;padding:4px 6px;font-size:12px}`;

  function buildWindow() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const w = document.createElement('div'); w.id = 'tn';
    w.innerHTML = `
      <div class="hd"><b>📐 네스팅 · G-code</b><span class="chip">자동 계산 · G-code 초안 · 가정 이송 · 파일까지만</span><span style="flex:1"></span><button id="tn-x">닫기</button></div>
      <div class="body">
        <div class="side">
          <div class="sec">부품 라이브러리<span class="sp"></span><label class="l" style="margin:0">두께</label><select id="tn-thk" style="width:84px"></select></div>
          <div class="lib" id="tn-lib"></div>
          <div class="g2" style="margin-top:6px"><button class="sm" id="tn-all">이 두께 모두 선택</button><button class="sm" id="tn-none">선택 해제</button></div>
          <div class="sec">DXF 불러오기</div>
          <div class="g2"><div><label class="l">판 두께 (mm)</label><input id="tn-dxf-t" type="number" value="12"></div>
            <div><label class="l">&nbsp;</label><button id="tn-dxf-b" style="width:100%">📥 .dxf 선택</button></div></div>
          <input id="tn-dxf" type="file" accept=".dxf" multiple style="display:none">
          <div class="sec">원판 (mm)</div>
          <div class="g2"><div><label class="l">길이 X</label><input id="tn-L" type="number" value="2440"></div><div><label class="l">폭 Y</label><input id="tn-W" type="number" value="1220"></div>
            <div><label class="l">여백</label><input id="tn-m" type="number" value="15"></div><div><label class="l">부품 간격</label><input id="tn-s" type="number" value="12"></div></div>
          <label style="display:block;margin-top:6px"><input id="tn-rot" type="checkbox" checked style="vertical-align:-2px"> 90° 회전 허용 (결 없음)</label>
          <div class="sec">공구 · 절삭 (가정값)</div>
          <div class="g3"><div><label class="l">공구 Ø</label><input id="tn-d" type="number" value="6"></div><div><label class="l">절입/패스</label><input id="tn-sd" type="number" value="4"></div><div><label class="l">이송 mm/min</label><input id="tn-f" type="number" value="3000"></div></div>
          <div class="sec">고정 탭</div>
          <div class="g3"><div><label class="l">개수</label><input id="tn-tc" type="number" value="4"></div><div><label class="l">폭</label><input id="tn-tw" type="number" value="8"></div><div><label class="l">높이</label><input id="tn-th" type="number" value="2"></div></div>
          <div class="sec">설비</div><select id="tn-router"></select>
        </div>
        <div class="main">
          <canvas id="tn-cv"></canvas>
          <div class="bar">
            <button id="tn-dl" disabled>💾 .nc 저장</button><button class="pri" id="tn-send" disabled>라우터로 보내기 ▶</button>
            <span class="msg" id="tn-msg">부품을 체크하면 자동으로 네스팅됩니다.</span>
            <span class="legend"><span><i style="background:rgba(56,189,248,.5)"></i>부품</span><span><i style="background:#1f2937"></i>공구 경로</span><span><i style="background:#ef4444"></i>탭</span></span>
          </div>
          <textarea id="tn-code" readonly placeholder="G-code 미리보기"></textarea>
        </div>
      </div>`;
    document.body.appendChild(w);
    $('tn-x').onclick = close;
    $('tn-dl').onclick = download;
    $('tn-send').onclick = send;
    $('tn-dxf-b').onclick = () => $('tn-dxf').click();
    $('tn-dxf').onchange = async e => { for (const f of e.target.files) await importDxf(f); e.target.value = ''; };
    $('tn-thk').onchange = () => { renderLibrary(); schedule(); };
    $('tn-all').onclick = () => { library.filter(p => p.thickness === parseFloat($('tn-thk').value)).forEach(p => { if (!sel.get(p.id)) sel.set(p.id, 1); }); renderLibrary(); schedule(); };
    $('tn-none').onclick = () => { sel.clear(); renderLibrary(); schedule(); };
    w.querySelectorAll('.side input:not([type=file]), .side select:not(#tn-thk)').forEach(el => el.addEventListener('input', schedule));
    $('tn-lib').addEventListener('change', e => {
      const id = e.target.dataset.id; if (!id) return;
      if (e.target.type === 'checkbox') sel.set(id, e.target.checked ? Math.max(1, sel.get(id) || 1) : 0);
      else sel.set(id, Math.max(0, Math.round(parseFloat(e.target.value) || 0)));
      renderLibrary(); schedule();
    });
    $('tn-lib').addEventListener('click', e => { const id = e.target.dataset.del; if (id && confirm('라이브러리에서 이 부품을 삭제할까요?')) deletePart(id); });
    addEventListener('resize', () => { if (w.style.display === 'flex') drawPreview(); });
  }

  function fillThickness(prefer) {
    const ts = [...new Set(library.map(p => p.thickness))].sort((a, b) => a - b);
    const cur = prefer ?? parseFloat($('tn-thk').value);
    $('tn-thk').innerHTML = ts.map(t => `<option value="${t}">${t} mm</option>`).join('') || '<option value="">–</option>';
    if (ts.includes(cur)) $('tn-thk').value = String(cur);
  }

  function renderLibrary() {
    const thk = parseFloat($('tn-thk').value);
    const list = library.filter(p => p.thickness === thk);
    $('tn-lib').innerHTML = list.length ? list.map(p => {
      const q = sel.get(p.id) || 0;
      return `<div class="item ${q ? 'on' : ''}"><input type="checkbox" data-id="${p.id}" ${q ? 'checked' : ''}>
        <div>${esc(p.name)}<span class="src">${p.source === 'dxf' ? 'DXF' : '스케치'}</span><small>${sizeOf(p)}×${p.thickness} mm · 구멍 ${(p.holes || []).length}</small></div>
        <input type="number" min="0" value="${q}" data-id="${p.id}" title="수량">
        <button class="sm" data-del="${p.id}" title="삭제">✕</button></div>`;
    }).join('') : `<div class="empty">${library.length ? '이 두께의 부품이 없습니다.' : '라이브러리가 비어 있습니다. 모델링 창의 “📚 라이브러리에 저장”, 또는 DXF 불러오기.'}</div>`;
  }

  async function open() {
    await syncPlacedDesigns();
    await loadLibrary();
    fillThickness();
    renderLibrary();
    const rs = routers();
    $('tn-router').innerHTML = rs.map(o => `<option>${o.name}</option>`).join('') || '<option value="">CNC 라우터 없음</option>';
    $('tn').style.display = 'flex';
    generate();
  }
  function close() { $('tn').style.display = 'none'; }
  function msg(t, err) { const m = $('tn-msg'); m.textContent = t; m.className = 'msg' + (err ? ' err' : ''); }

  /** Parts placed in the factory are saved to the library too (server dedupes by geometry). */
  async function syncPlacedDesigns() {
    const ds = placedObjects.filter(o => o.userData && o.userData.isExtrudedSketch && o.userData.vertices && !o.userData.libraryId);
    for (const o of ds) {
      try {
        const ud = o.userData;
        const r = await savePart({ name: o.name, thickness: ud.thickness, vertices: ud.vertices.map(p => ({ x: +p.x, y: +p.y })), holes: (ud.holes || []).filter(h => h.isSubtract).map(h => ({ x: +h.x, y: +h.y, dia: +h.dia })), source: 'sketch' });
        ud.libraryId = r.part.id;
      } catch (e) { /* invalid legacy sketch — skip */ }
    }
  }

  // ------------------------------------------------------------------ modeling window: save button
  function addSaveToModeling() {
    const ext = document.querySelector('#cad-sketch-panel button[onclick="cadSketchExecuteExtrude()"]');
    if (!ext || document.getElementById('tn-save-name')) return;
    const box = document.createElement('div'); box.className = 'tn-save';
    box.innerHTML = `<input id="tn-save-name" placeholder="부품 이름 (비우면 자동)"><button class="btn-tb" id="tn-save-btn" style="white-space:nowrap;color:#a5f3fc;border-color:#0891b2">📚 라이브러리에 저장</button>`;
    ext.parentElement.appendChild(box);
    $('tn-save-btn').onclick = async () => {
      try { const r = await saveCurrentSketch($('tn-save-name').value); $('tn-save-btn').textContent = r.existing ? '✓ 이미 저장됨' : '✓ 저장됨'; }
      catch (e) { log(`⚠️ [라이브러리] 저장 실패: ${e.message}`); $('tn-save-btn').textContent = '⚠ ' + e.message.slice(0, 18); }
      setTimeout(() => { $('tn-save-btn').textContent = '📚 라이브러리에 저장'; }, 2200);
    };
  }

  function start() {
    const tools = document.querySelector('#tl .tools');
    if (!tools || typeof placedObjects === 'undefined') return setTimeout(start, 400);
    buildWindow();
    addSaveToModeling();
    const b = document.createElement('button');
    b.textContent = '📐 네스팅 · G-code'; b.title = '부품 라이브러리 → 자동 네스팅 → G-code → 라우터';
    b.onclick = open;
    tools.insertBefore(b, tools.children[1]);
    // placing a part in the factory also stores it in the library
    const orig = window.cadStudioApplyToFactoryScene;
    if (typeof orig === 'function') {
      window.cadStudioApplyToFactoryScene = function () {
        const r = orig.apply(this, arguments);
        saveCurrentSketch('', true).then(x => { const o = placedObjects[placedObjects.length - 1]; if (o && o.userData) o.userData.libraryId = x.part.id; }).catch(() => {});
        return r;
      };
    }
  }

  window.TwinNest = { drive, onEvent, open, generate, saveCurrentSketch, importDxf, get last() { return last; }, get library() { return library; }, select: (id, q) => { sel.set(id, q); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
