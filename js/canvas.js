/*
 * canvas.js —— 自研 SVG 画布（零依赖，不引任何图编辑库）。
 *
 * 这是整个项目里"最手写"的部分，也是简历上最硬的一格。要点：
 *  - 渲染：每次改动整体重绘 nodes / edges 两个 <g>（图小，开销可忽略）。
 *  - 坐标：viewport 用 transform="translate(tx,ty) scale(k)"，世界坐标↔屏幕坐标互相换算。
 *  - 交互：拖背景=平移；滚轮=以光标为锚点缩放；拖节点=移动；从输出圆点拉到输入圆点=建边。
 *  - 端口位置：输入在左缘、输出在右缘，按端口数均匀分布在节点高度上。
 *  - 选中：点节点 / 点边选中，按 Delete 删除（经回调通知外层刷新属性面板）。
 *
 * 所有命中检测用 element.closest(...)，所以点到节点的子元素（文字、端口）也能正确归到节点。
 */
(function (global) {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const NODE_W = 184;
  const NODE_H = 84; // 抬高以容纳"上次输出"那一行
  const MAX_OUTPUT_LEN = 30;

  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o == null ? {} : o));
  }

  class Canvas {
    constructor(svg, graph, callbacks) {
      this.svg = svg;
      this.graph = graph;
      this.cb = callbacks || {};
      this.viewport = svg.querySelector('#viewport');
      this.edgesG = svg.querySelector('#edges');
      this.nodesG = svg.querySelector('#nodes');

      this.tx = 60;
      this.ty = 60;
      this.k = 1;
      this._outputs = {}; // nodeId -> 上次输出（运行态，render 时清空）
      this.selected = null; // { kind:'node'|'edge', id }
      this.mode = null; // 'pan' | 'drag' | 'edge'
      this.dragNode = null;
      this.dragOffset = { x: 0, y: 0 };
      this.panStart = null;
      this.edgeFrom = null;
      this.tempPath = null;

      this._bind();
      this.applyTransform();
    }

    /* ---------- 坐标换算 ---------- */
    screenToWorld(clientX, clientY) {
      const r = this.svg.getBoundingClientRect();
      return { x: (clientX - r.left - this.tx) / this.k, y: (clientY - r.top - this.ty) / this.k };
    }

    applyTransform() {
      this.viewport.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.k})`);
    }

    /* ---------- 端口几何 ---------- */
    portPos(node, side, index) {
      const def = (global.FC.NODE_TYPES || {})[node.type] || { inputs: [], outputs: [] };
      const total = side === 'in' ? def.inputs.length : def.outputs.length;
      const x = side === 'in' ? node.x : node.x + NODE_W;
      const y = node.y + 22 + ((index + 0.5) * (NODE_H - 22)) / Math.max(total, 1);
      return { x, y };
    }

    /* ---------- 渲染 ---------- */
    render() {
      this.edgesG.textContent = '';
      this.nodesG.textContent = '';
      this._outputs = {};
      this.graph.edges.forEach((e) => this._drawEdge(e));
      this.graph.nodes.forEach((n) => this._drawNode(n));
    }

    _drawEdge(edge) {
      const s = this.graph.getNode(edge.source.node);
      const t = this.graph.getNode(edge.target.node);
      if (!s || !t) return;
      const p1 = this.portPos(s, 'out', this._portIndex(s, edge.source.port, 'out'));
      const p2 = this.portPos(t, 'in', this._portIndex(t, edge.target.port, 'in'));
      const d = this._bezier(p1, p2);
      const hit = svgEl('path', { class: 'edge-hit', d });
      hit.dataset.edgeId = edge.id;
      const path = svgEl('path', { class: 'edge-path', d, 'marker-end': 'url(#arrow)' });
      if (this.selected && this.selected.kind === 'edge' && this.selected.id === edge.id) {
        path.classList.add('active');
      }
      hit.addEventListener('mousedown', (ev) => this._onEdgeDown(ev, edge.id));
      this.edgesG.appendChild(hit);
      this.edgesG.appendChild(path);
    }

    _portIndex(node, port, side) {
      const def = (global.FC.NODE_TYPES || {})[node.type] || { inputs: [], outputs: [] };
      const arr = side === 'in' ? def.inputs : def.outputs;
      const i = arr.indexOf(port);
      return i < 0 ? 0 : i;
    }

    _bezier(p1, p2) {
      const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.5);
      return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
    }

    _drawNode(node) {
      const def = (global.FC.NODE_TYPES || {})[node.type] || { title: node.type, color: '#475569', inputs: [], outputs: [] };
      const g = svgEl('g', { class: 'node', transform: `translate(${node.x},${node.y})` });
      g.dataset.nodeId = node.id;
      if (this.selected && this.selected.kind === 'node' && this.selected.id === node.id) g.classList.add('selected');

      const rect = svgEl('rect', { class: 'node-rect', width: NODE_W, height: NODE_H, rx: 8, fill: def.color });
      g.appendChild(rect);

      const title = svgEl('text', { class: 'node-title', x: 12, y: 24 });
      title.textContent = def.title;
      g.appendChild(title);

      const sub = svgEl('text', { class: 'node-sub', x: 12, y: 44 });
      sub.textContent = this._subtitle(node, def);
      g.appendChild(sub);

      // 上次运行输出（运行态，render 时为空）。超长截断，鼠标悬停看全量。
      const out = svgEl('text', { class: 'node-output', x: 12, y: 64 });
      const cap = this._outputs[node.id] || '';
      out.textContent = cap.length > MAX_OUTPUT_LEN ? cap.slice(0, MAX_OUTPUT_LEN) + '…' : cap;
      if (cap) out.style.cursor = 'help';
      g.appendChild(out);

      // 端口
      def.inputs.forEach((p, i) => {
        const y = 22 + ((i + 0.5) * (NODE_H - 22)) / Math.max(def.inputs.length, 1);
        const c = svgEl('circle', { class: 'port port-in', cx: 0, cy: y, r: 6, 'data-node': node.id, 'data-port': p, 'data-side': 'in' });
        g.appendChild(c);
      });
      def.outputs.forEach((p, i) => {
        const y = 22 + ((i + 0.5) * (NODE_H - 22)) / Math.max(def.outputs.length, 1);
        const c = svgEl('circle', { class: 'port port-out', cx: NODE_W, cy: y, r: 6, 'data-node': node.id, 'data-port': p, 'data-side': 'out' });
        g.appendChild(c);
      });

      // 整个节点组可拖动 / 选中（端口单独处理）
      g.addEventListener('mousedown', (ev) => this._onNodeDown(ev, node.id));
      this.nodesG.appendChild(g);
    }

    _subtitle(node, def) {
      const c = node.config || {};
      switch (node.type) {
        case 'start':
          return (c.text || '').slice(0, 22);
        case 'llm':
          return c.mock ? '模拟模式' : c.model || '真实调用';
        case 'if':
          return `${c.op || ''} "${c.value || ''}"`;
        case 'transform':
          return (c.code || '').split('\n')[0].slice(0, 22);
        case 'http':
          return `${c.method || 'GET'} ${c.url || ''}`.slice(0, 26);
        case 'end':
          return '终点';
        default:
          return '';
      }
    }

    /* ---------- 交互 ---------- */
    _bind() {
      this.svg.addEventListener('mousedown', (e) => this._onDown(e));
      window.addEventListener('mousemove', (e) => this._onMove(e));
      window.addEventListener('mouseup', (e) => this._onUp(e));
      this.svg.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      window.addEventListener('keydown', (e) => this._onKey(e));
    }

    _onDown(e) {
      const portEl = e.target.closest ? e.target.closest('.port') : null;
      if (portEl && portEl.dataset.side === 'out') {
        e.preventDefault();
        this.mode = 'edge';
        this.edgeFrom = { node: portEl.dataset.node, port: portEl.dataset.port };
        const s = this.graph.getNode(this.edgeFrom.node);
        const p1 = this.portPos(s, 'out', this._portIndex(s, this.edgeFrom.port, 'out'));
        this.tempPath = svgEl('path', { class: 'temp-edge', d: `M ${p1.x} ${p1.y} L ${p1.x} ${p1.y}` });
        this.edgesG.appendChild(this.tempPath);
        return;
      }
      const nodeEl = e.target.closest ? e.target.closest('[data-node-id]') : null;
      if (nodeEl) {
        e.preventDefault();
        const id = nodeEl.dataset.nodeId;
        this.select('node', id);
        this.mode = 'drag';
        const node = this.graph.getNode(id);
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.dragOffset = { x: w.x - node.x, y: w.y - node.y };
        return;
      }
      const edgeEl = e.target.closest ? e.target.closest('[data-edge-id]') : null;
      if (edgeEl) {
        this.select('edge', edgeEl.dataset.edgeId);
        return;
      }
      // 背景：平移
      this.mode = 'pan';
      this.panStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      this.svg.classList.add('panning');
    }

    _onMove(e) {
      if (this.mode === 'edge' && this.tempPath) {
        const p1node = this.graph.getNode(this.edgeFrom.node);
        const p1 = this.portPos(p1node, 'out', this._portIndex(p1node, this.edgeFrom.port, 'out'));
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.tempPath.setAttribute('d', this._bezier(p1, w));
        return;
      }
      if (this.mode === 'drag') {
        const id = this.selected && this.selected.kind === 'node' ? this.selected.id : null;
        if (!id) return;
        const node = this.graph.getNode(id);
        const w = this.screenToWorld(e.clientX, e.clientY);
        node.x = Math.round(w.x - this.dragOffset.x);
        node.y = Math.round(w.y - this.dragOffset.y);
        this.render();
        if (this.cb.onChange) this.cb.onChange();
        return;
      }
      if (this.mode === 'pan' && this.panStart) {
        this.tx = this.panStart.tx + (e.clientX - this.panStart.x);
        this.ty = this.panStart.ty + (e.clientY - this.panStart.y);
        this.applyTransform();
      }
    }

    _onUp(e) {
      if (this.mode === 'edge' && this.edgeFrom) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const portEl = el && el.closest ? el.closest('.port-in') : null;
        if (portEl && portEl.dataset.node !== this.edgeFrom.node) {
          const edge = this.graph.addEdge(
            { node: this.edgeFrom.node, port: this.edgeFrom.port },
            { node: portEl.dataset.node, port: portEl.dataset.port }
          );
          if (edge && this.cb.onChange) this.cb.onChange();
        }
        if (this.tempPath) {
          this.tempPath.remove();
          this.tempPath = null;
        }
        this.edgeFrom = null;
      }
      this.mode = null;
      this.dragNode = null;
      this.panStart = null;
      this.svg.classList.remove('panning');
      this.render();
    }

    _onWheel(e) {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const wx = (sx - this.tx) / this.k;
      const wy = (sy - this.ty) / this.k;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.k = Math.min(2.5, Math.max(0.3, this.k * factor));
      this.tx = sx - wx * this.k;
      this.ty = sy - wy * this.k;
      this.applyTransform();
    }

    _onKey(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (this.cb.onSave) this.cb.onSave();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 正在编辑属性时不删节点
        if (this.selected.kind === 'node') this.graph.removeNode(this.selected.id);
        else this.graph.removeEdge(this.selected.id);
        this.selected = null;
        this.render();
        if (this.cb.onSelect) this.cb.onSelect(null);
        if (this.cb.onChange) this.cb.onChange();
      }
    }

    /* ---------- 选中 / 增删 / 视图 ---------- */
    select(kind, id) {
      this.selected = kind ? { kind, id } : null;
      this.render();
      if (this.cb.onSelect) this.cb.onSelect(this.selected);
    }

    addNode(type) {
      const def = (global.FC.NODE_TYPES || {})[type];
      if (!def) return;
      const r = this.svg.getBoundingClientRect();
      const center = this.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
      const node = this.graph.addNode(type, Math.round(center.x - NODE_W / 2), Math.round(center.y - NODE_H / 2), clone(def.defaultConfig));
      this.select('node', node.id);
      if (this.cb.onChange) this.cb.onChange();
      return node;
    }

    setSelectedRunning(nodeId, state) {
      // state: 'running' | 'done' | 'error' | null
      const g = this.nodesG.querySelector(`[data-node-id="${nodeId}"]`);
      if (!g) return;
      g.classList.remove('running', 'done', 'error');
      if (state) g.classList.add(state);
    }

    setEdgeFired(edgeId) {
      const hit = this.edgesG.querySelector(`[data-edge-id="${edgeId}"]`);
      if (hit && hit.nextSibling) hit.nextSibling.classList.add('fired');
    }

    /** 设置/更新某个节点的"上次输出"标题（直接改 DOM，不整体重绘以保住运行态） */
    setNodeOutput(nodeId, text) {
      this._outputs[nodeId] = text != null ? String(text) : '';
      const g = this.nodesG.querySelector(`[data-node-id="${nodeId}"]`);
      if (!g) return;
      const el = g.querySelector('text.node-output');
      if (!el) return;
      const v = this._outputs[nodeId];
      el.textContent = v.length > MAX_OUTPUT_LEN ? v.slice(0, MAX_OUTPUT_LEN) + '…' : v;
      if (v) el.setAttribute('title', v);
    }

    getNodeOutput(nodeId) {
      return this._outputs[nodeId] || '';
    }

    fit() {
      if (!this.graph.nodes.length) {
        this.tx = 60;
        this.ty = 60;
        this.k = 1;
        this.applyTransform();
        return;
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      this.graph.nodes.forEach((n) => {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + NODE_W);
        maxY = Math.max(maxY, n.y + NODE_H);
      });
      const r = this.svg.getBoundingClientRect();
      const pad = 60;
      const k = Math.min(2.5, Math.max(0.3, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))));
      this.k = k;
      this.tx = pad - minX * k + (r.width - pad * 2 - (maxX - minX) * k) / 2;
      this.ty = pad - minY * k + (r.height - pad * 2 - (maxY - minY) * k) / 2;
      this.applyTransform();
    }

    _onEdgeDown(ev, id) {
      ev.preventDefault();
      ev.stopPropagation();
      this.select('edge', id);
    }
  }

  global.FC = global.FC || {};
  global.FC.Canvas = Canvas;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Canvas };
})(typeof window !== 'undefined' ? window : globalThis);
