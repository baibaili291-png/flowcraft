/*
 * main.js —— 应用入口：把画布、引擎、属性面板、工具栏串起来。
 * 纯原生，无框架。打开 index.html 即可用（file:// 也行）。
 */
(function () {
  'use strict';

  const FC = window.FC;
  const { Graph, NODE_TYPES, Engine, Store, Canvas } = FC;

  // 默认示例工作流：一条"功率检查"分支流程，演示条件路由 + 汇聚到终点。
  const DEFAULT_WORKFLOW = {
    nodes: [
      { id: 's1', type: 'start', x: 40, y: 140, config: { text: '请检查：设备功率为 18W' } },
      { id: 'c1', type: 'if', x: 300, y: 140, config: { op: 'contains', value: '18W' } },
      { id: 't1', type: 'llm', x: 560, y: 40, config: { mock: true, model: 'deepseek-chat', prompt: '功率正常，无需处理：{{text}}', baseUrl: '', apiKey: '' } },
      { id: 't2', type: 'llm', x: 560, y: 260, config: { mock: true, model: 'deepseek-chat', prompt: '功率异常，请排查：{{text}}', baseUrl: '', apiKey: '' } },
      { id: 'e1', type: 'end', x: 840, y: 150, config: {} },
    ],
    edges: [
      { id: 'e1', source: { node: 's1', port: 'text' }, target: { node: 'c1', port: 'text' } },
      { id: 'e2', source: { node: 'c1', port: 'true' }, target: { node: 't1', port: 'text' } },
      { id: 'e3', source: { node: 'c1', port: 'false' }, target: { node: 't2', port: 'text' } },
      { id: 'e4', source: { node: 't1', port: 'text' }, target: { node: 'e1', port: 'text' } },
      { id: 'e5', source: { node: 't2', port: 'text' }, target: { node: 'e1', port: 'text' } },
    ],
  };

  const $ = (id) => document.getElementById(id);
  const graph = new Graph();
  let abort = null;

  const canvas = new Canvas($('canvas'), graph, {
    onSelect: (sel) => renderProps(sel),
    onChange: () => Store.save(graph),
    onSave: () => {
      Store.save(graph);
      setStatus('已保存到本地（Ctrl+S）');
    },
  });

  /* ---------- 工具栏 ---------- */
  function setStatus(t) {
    $('status').textContent = t;
  }
  function clearLog() {
    $('log').innerHTML = '';
  }
  function log(kind, text) {
    const div = document.createElement('div');
    div.className = 'row ' + (kind || 'info');
    div.textContent = text;
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
  }

  /* ---------- 属性面板 ---------- */
  function renderProps(sel) {
    const box = $('props');
    box.innerHTML = '';
    if (!sel) {
      box.innerHTML = '<div class="props-empty">未选中节点</div>';
      return;
    }
    if (sel.kind === 'edge') {
      const e = graph.edges.find((x) => x.id === sel.id);
      if (!e) {
        box.innerHTML = '<div class="props-empty">边已删除</div>';
        return;
      }
      const s = graph.getNode(e.source.node);
      const t = graph.getNode(e.target.node);
      const title = document.createElement('div');
      title.className = 'field';
      title.innerHTML =
        `<label>边</label><div>${NODE_TYPES[s.type].title}.${e.source.port} → ${NODE_TYPES[t.type].title}.${e.target.port}</div>`;
      box.appendChild(title);
      const del = document.createElement('button');
      del.textContent = '删除这条边';
      del.onclick = () => {
        graph.removeEdge(sel.id);
        canvas.select(null, null);
        Store.save(graph);
      };
      box.appendChild(del);
      return;
    }

    // 节点
    const node = graph.getNode(sel.id);
    if (!node) {
      box.innerHTML = '<div class="props-empty">节点已删除</div>';
      return;
    }
    const def = NODE_TYPES[node.type];
    const h = document.createElement('div');
    h.className = 'field';
    h.innerHTML = `<label>类型</label><div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${def.color};margin-right:6px;"></span>${def.title}</div>`;
    box.appendChild(h);

    const ports = document.createElement('div');
    ports.className = 'field';
    ports.innerHTML = `<label>端口</label><div>入：${def.inputs.join(', ') || '无'} ｜ 出：${def.outputs.join(', ') || '无'}</div>`;
    box.appendChild(ports);

    // 上次运行输出（只读，点击运行后才有）
    const cap = canvas.getNodeOutput(node.id);
    if (cap) {
      const out = document.createElement('div');
      out.className = 'field';
      const lbl = document.createElement('label');
      lbl.textContent = '上次输出';
      const box2 = document.createElement('div');
      box2.className = 'readonly-box';
      box2.textContent = cap; // textContent 避免输出里的尖括号被当 HTML
      out.appendChild(lbl);
      out.appendChild(box2);
      box.appendChild(out);
    }

    (def.fields || []).forEach((f) => {
      const field = document.createElement('div');
      field.className = 'field';
      const label = document.createElement('label');
      label.textContent = f.label;
      field.appendChild(label);
      let input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.value = node.config[f.key] || '';
      } else if (f.type === 'select') {
        input = document.createElement('select');
        (f.options || []).forEach((opt) => {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          if (node.config[f.key] === opt) o.selected = true;
          input.appendChild(o);
        });
      } else if (f.type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!node.config[f.key];
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = node.config[f.key] != null ? node.config[f.key] : '';
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      const commit = () => {
        if (f.type === 'checkbox') node.config[f.key] = input.checked;
        else node.config[f.key] = input.value;
        canvas.render();
        Store.save(graph);
      };
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);
      field.appendChild(input);
      if (f.placeholder && f.type !== 'text') {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = f.placeholder;
        field.appendChild(hint);
      }
      box.appendChild(field);
    });
  }

  /* ---------- 运行 ---------- */
  // 把节点的结构化输出压成一行可读文本（用于卡片标题 / 属性面板）
  function fmtOutput(info) {
    const o = info.outputs || {};
    if (o.__branch) return '分支 → ' + o.__branch;
    const keys = Object.keys(o).filter((k) => k !== '__branch');
    if (!keys.length) return '';
    if (keys.length === 1) return String(o[keys[0]]);
    return keys.map((k) => k + '=' + o[k]).join('  ');
  }

  async function run() {
    if (abort) return;
    canvas.render();
    clearLog();
    abort = new AbortController();
    $('btn-run').disabled = true;
    setStatus('运行中…');
    log('info', '开始执行工作流（' + graph.nodes.length + ' 个节点）');
    const engine = new Engine(graph);
    try {
      await engine.run({
        signal: abort.signal,
        stepDelay: 300,
        onNodeStart: (id) => canvas.setSelectedRunning(id, 'running'),
        onNodeDone: (id, info) => {
          canvas.setSelectedRunning(id, info.error ? 'error' : info.skipped ? null : 'done');
          const node = graph.getNode(id);
          // 卡片标题：普通节点显示自身输出；终点节点显示它收到的"最终答案"
          let cap = fmtOutput(info);
          if (node && node.type === 'end') {
            cap = info.inputs && info.inputs.text != null ? info.inputs.text : '(空)';
            log('info', '★ 最终输出：' + cap);
          }
          if (cap) canvas.setNodeOutput(id, cap);
          // 若当前选中的就是这个节点，刷新属性面板里的"上次输出"
          if (canvas.selected && canvas.selected.kind === 'node' && canvas.selected.id === id) {
            renderProps({ kind: 'node', id });
          }
        },
        onEdgeFired: (id) => canvas.setEdgeFired(id),
        onLog: (row) => log(row.kind, (row.node ? '[' + NODE_TYPES[row.node].title + '] ' : '') + row.text),
      });
    } catch (e) {
      log('error', e.message);
    } finally {
      $('btn-run').disabled = false;
      abort = null;
      setStatus('就绪 · 点"运行"重跑 / 改动后自动保存');
    }
  }

  /* ---------- 节点面板 ---------- */
  function buildPalette() {
    const pal = $('palette');
    Object.values(NODE_TYPES).forEach((def) => {
      const btn = document.createElement('button');
      btn.className = 'node-btn';
      btn.innerHTML = `<span class="dot" style="background:${def.color}"></span><span class="name">${def.title}</span>`;
      btn.onclick = () => canvas.addNode(def.type);
      pal.appendChild(btn);
    });
  }

  /* ---------- 按钮绑定 ---------- */
  $('btn-run').onclick = run;
  $('btn-stop').onclick = () => {
    if (abort) abort.abort();
  };
  $('btn-save').onclick = () => {
    Store.save(graph);
    setStatus('已保存到本地');
  };
  $('btn-load').onclick = () => {
    if (Store.load(graph)) {
      canvas.render();
      canvas.fit();
      setStatus('已从本地读取');
    } else {
      setStatus('本地无存档');
    }
  };
  $('btn-fit').onclick = () => canvas.fit();
  $('btn-clear').onclick = () => {
    if (graph.nodes.length && !confirm('确定清空画布？')) return;
    graph.clear();
    canvas.select(null, null);
    Store.save(graph);
    setStatus('已清空');
  };
  $('btn-export').onclick = () => {
    const blob = new Blob([Store.export(graph)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flowcraft-workflow.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  $('btn-import').onclick = () => $('file-input').click();
  $('file-input').onchange = (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        Store.import(graph, reader.result);
        canvas.render();
        canvas.fit();
        Store.save(graph);
        setStatus('已导入');
      } catch (e) {
        alert('导入失败：' + e.message);
      }
    };
    reader.readAsText(file);
    ev.target.value = '';
  };

  /* ---------- 启动 ---------- */
  buildPalette();
  if (!Store.load(graph)) graph.load(JSON.parse(JSON.stringify(DEFAULT_WORKFLOW)));
  canvas.render();
  canvas.fit();
  renderProps(null);
  setStatus('就绪 · 点"运行"看效果');

  // 演示/自动化验证用：?autorun=1 打开后自动跑一次
  if (new URLSearchParams(location.search).has('autorun')) {
    setTimeout(run, 300);
  }
})();
