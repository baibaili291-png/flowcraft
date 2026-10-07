/*
 * graph.js —— 工作流的数据模型（与渲染、执行都解耦）。
 *
 * 一个工作流 = 节点(node) + 有向边(edge)。
 *  - node: { id, type, x, y, config }
 *  - edge: { id, source:{node,port}, target:{node,port} }
 *
 * 这里只管"逻辑数据"：增删节点/边、序列化。坐标几何（端口画在哪）属于画布层，
 * 拓扑/执行属于引擎层。三层各管各的，方便单测，也方便将来把后端换成数据库。
 */
(function (global) {
  'use strict';

  class Graph {
    constructor() {
      this.nodes = [];
      this.edges = [];
      this._seq = 0;
    }

    newId(prefix) {
      this._seq += 1;
      return (prefix || 'n') + this._seq + '_' + Math.random().toString(36).slice(2, 6);
    }

    addNode(type, x, y, config) {
      const node = { id: this.newId(type), type, x: x | 0, y: y | 0, config: config || {} };
      this.nodes.push(node);
      return node;
    }

    getNode(id) {
      return this.nodes.find((n) => n.id === id) || null;
    }

    removeNode(id) {
      this.nodes = this.nodes.filter((n) => n.id !== id);
      // 顺手删掉挂在这个节点上的所有边
      this.edges = this.edges.filter((e) => e.source.node !== id && e.target.node !== id);
    }

    addEdge(source, target) {
      // source/target 形如 { node, port }
      if (!source || !target || source.node === target.node) return null;
      const dup = this.edges.find(
        (e) =>
          e.source.node === source.node &&
          e.source.port === source.port &&
          e.target.node === target.node &&
          e.target.port === target.port
      );
      if (dup) return null;
      const edge = { id: this.newId('e'), source, target };
      this.edges.push(edge);
      return edge;
    }

    removeEdge(id) {
      this.edges = this.edges.filter((e) => e.id !== id);
    }

    incoming(id) {
      return this.edges.filter((e) => e.target.node === id);
    }

    outgoing(id) {
      return this.edges.filter((e) => e.source.node === id);
    }

    toJSON() {
      return { version: 1, nodes: this.nodes, edges: this.edges };
    }

    load(json) {
      this.nodes = Array.isArray(json.nodes) ? json.nodes.map((n) => ({ ...n })) : [];
      this.edges = Array.isArray(json.edges) ? json.edges.map((e) => ({ ...e })) : [];
      this._seq = this.nodes.length + this.edges.length + 1;
    }

    clear() {
      this.nodes = [];
      this.edges = [];
    }
  }

  global.FC = global.FC || {};
  global.FC.Graph = Graph;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Graph };
})(typeof window !== 'undefined' ? window : globalThis);
