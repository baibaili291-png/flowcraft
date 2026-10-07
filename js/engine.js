/*
 * engine.js —— 自研 DAG 执行引擎。
 *
 * 为什么不直接用现成的编排库（n8n / LangChain / Airflow）：
 * 简历项目要的是"我能手写一个"，而且这几个点现成库都替你做了、反而说不清：
 *   1) 拓扑排序 + 环检测（Kahn）
 *   2) 多输入汇聚（一个节点要等齐所有"活着的"上游才跑）
 *   3) 条件分支（if 节点只激活一条出边，另一条整条链路被自然剪枝）
 *   4) 条件合并（两条分支汇聚到一个节点时，被剪掉的那条不能堵死终点）
 *   5) 异步节点 + 逐步回调（用于前端高亮当前节点、展示每一步输出）
 *
 * 执行模型（worklist + "活输入"计数）：
 *  - required[node] 初始 = 入边数。每条边 fire 时 received++；
 *    received >= required 就进队列执行。
 *  - 条件节点只 fire 被激活端口对应的边；**被剪掉的边要"通知"下游**：
 *    required[target]--。这样两种情况都能正确处理：
 *      · 下游只靠被剪的边活着（required 归 0 且一个输入都没收到）→ 整块跳过，且继续向下级联；
 *      · 下游是两条分支的合并点（如"结束"节点）→ required 从 2 减到 1，
 *        已到的那条输入就够它跑了。**没有这个机制，条件合并的终点永远不执行。**
 *  - 引擎不依赖任何 DOM，可被 node 直接单测（test/engine.test.js）。
 */
(function (global) {
  'use strict';

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  class Engine {
    constructor(graph) {
      this.graph = graph;
    }

    /** Kahn 拓扑排序，顺便做环检测 */
    topoSort() {
      const indeg = {};
      this.graph.nodes.forEach((n) => (indeg[n.id] = 0));
      this.graph.edges.forEach((e) => {
        if (indeg[e.target.node] != null) indeg[e.target.node] += 1;
      });
      const queue = this.graph.nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id);
      const order = [];
      while (queue.length) {
        const id = queue.shift();
        order.push(id);
        this.graph.outgoing(id).forEach((e) => {
          if (indeg[e.target.node] != null) {
            indeg[e.target.node] -= 1;
            if (indeg[e.target.node] === 0) queue.push(e.target.node);
          }
        });
      }
      return { order, hasCycle: order.length !== this.graph.nodes.length };
    }

    /**
     * 执行整张图。
     * @param {object} opts
     *   onNodeStart(nodeId)
     *   onNodeDone(nodeId, {inputs, outputs, error, skipped})
     *   onEdgeFired(edgeId)
     *   onLog(row)  row = {kind, node, text}
     *   stepDelay   节点之间的可视化间隔(ms)
     *   signal      AbortSignal，用于"停止"
     */
    async run(opts) {
      const o = opts || {};
      const TYPES = (global.FC && global.FC.NODE_TYPES) || {};
      const { hasCycle } = this.topoSort();
      if (hasCycle) {
        if (o.onLog) o.onLog({ kind: 'error', text: '✗ 工作流存在环（循环依赖），无法执行。请删除形成环的边。' });
        throw new Error('cycle detected');
      }

      const indeg = {};
      this.graph.nodes.forEach((n) => (indeg[n.id] = this.graph.incoming(n.id).length));
      const required = { ...indeg }; // 会随剪枝递减
      const received = {};
      const outputs = {}; // nodeId -> { port: value }
      this.graph.nodes.forEach((n) => (received[n.id] = 0));
      const processed = new Set();
      const queued = new Set();
      const queue = [];
      let ranCount = 0;
      let skippedCount = 0;

      this.graph.nodes.forEach((n) => {
        if (indeg[n.id] === 0) {
          queue.push(n.id);
          queued.add(n.id);
        }
      });

      // 剪枝级联：某条边确定不会 fire 时调用。
      // 下游少了一条输入；若它因此一个活输入都凑不到，就整块跳过并继续向下传。
      const markSkip = (id) => {
        if (processed.has(id)) return;
        processed.add(id);
        skippedCount += 1;
        const node = this.graph.getNode(id);
        if (o.onLog) {
          o.onLog({ kind: 'info', node: node.type, text: '⨉ 跳过（上游分支未激活，整条链路被剪枝）' });
        }
        if (o.onNodeDone) o.onNodeDone(id, { inputs: {}, outputs: {}, skipped: true });
        this.graph.outgoing(id).forEach((e) => skipEdge(e));
      };
      const skipEdge = (edge) => {
        const t = edge.target.node;
        if (processed.has(t)) return;
        required[t] -= 1;
        if (received[t] > 0 && received[t] >= required[t]) {
          // 剪掉死输入后，活输入已凑齐 → 可以跑了（条件合并的关键）
          if (!queued.has(t)) {
            queued.add(t);
            queue.push(t);
          }
        } else if (required[t] <= 0 && received[t] === 0 && indeg[t] > 0) {
          markSkip(t);
        }
      };

      while (queue.length) {
        if (o.signal && o.signal.aborted) {
          if (o.onLog) o.onLog({ kind: 'info', text: '■ 已手动停止。' });
          break;
        }
        const id = queue.shift();
        if (processed.has(id)) continue;
        processed.add(id);
        const node = this.graph.getNode(id);
        const def = TYPES[node.type];

        // 收集输入：每条入边从源节点对应端口取值。
        // 注意：只从"真的 fire 过"的边取——被剪枝的上游没有 outputs，
        // 若不跳过，它的 undefined 会把合并节点已收到的真值覆盖掉。
        const inputs = {};
        this.graph.incoming(id).forEach((e) => {
          const srcOut = outputs[e.source.node];
          if (srcOut === undefined) return; // 上游被剪枝 / 未执行，这条边没有值
          const v = srcOut[e.source.port];
          if (v !== undefined) inputs[e.target.port] = v;
        });

        if (o.onNodeStart) o.onNodeStart(id);
        if (o.onLog) o.onLog({ kind: 'start', node: node.type, text: `▶ 运行 ${def ? def.title : node.type}` });

        let result = {};
        let error = null;
        try {
          result = def ? await def.run(node.config, inputs) : {};
        } catch (err) {
          error = err.message || String(err);
        }

        if (error) {
          if (o.onNodeDone) o.onNodeDone(id, { inputs, outputs: {}, error });
          if (o.onLog) o.onLog({ kind: 'error', node: node.type, text: `✗ ${error}` });
          continue; // 出错不再传播出边，避免污染下游
        }

        outputs[id] = result;
        if (o.onNodeDone) o.onNodeDone(id, { inputs, outputs: result });
        const summary = describeOutput(result, node.type);
        if (summary && o.onLog) o.onLog({ kind: 'done', node: node.type, text: `✓ ${summary}` });

        // 传播出边：条件节点只 fire 被激活端口对应的边
        const branch = result.__branch;
        this.graph.outgoing(id).forEach((e) => {
          if (branch && e.source.port !== branch) {
            skipEdge(e); // 剪枝：通知下游这条边不会来
            return;
          }
          if (o.onEdgeFired) o.onEdgeFired(e.id);
          const t = e.target.node;
          received[t] += 1;
          if (!processed.has(t) && !queued.has(t) && received[t] >= required[t]) {
            queued.add(t);
            queue.push(t);
          }
        });

        ranCount += 1;
        if (o.stepDelay) await sleep(o.stepDelay);
      }

      if (o.onLog && (!o.signal || !o.signal.aborted)) {
        const total = this.graph.nodes.length;
        const skipInfo = skippedCount ? `（剪枝跳过 ${skippedCount} 个）` : '';
        o.onLog({ kind: 'info', text: `— 执行完毕：运行 ${ranCount}/${total} 个节点${skipInfo} —` });
      }
      return { ranCount, skippedCount, total: this.graph.nodes.length, outputs };
    }
  }

  function describeOutput(result) {
    if (result.__branch) return `分支 → ${result.__branch}`;
    const keys = Object.keys(result).filter((k) => k !== '__branch');
    if (keys.length === 0) return '';
    const parts = keys.map((k) => {
      let v = result[k];
      if (typeof v === 'string') v = v.length > 60 ? v.slice(0, 60) + '…' : v;
      return `${k}=${v}`;
    });
    return parts.join('  ');
  }

  global.FC = global.FC || {};
  global.FC.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Engine };
})(typeof window !== 'undefined' ? window : globalThis);
