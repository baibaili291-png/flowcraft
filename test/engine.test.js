/* FlowCraft 引擎单测（纯逻辑，可用 node 直接跑） */
const { Graph } = require('../js/graph.js');
const { NODE_TYPES } = require('../js/nodes.js');
const { Engine } = require('../js/engine.js');

function build() {
  const g = new Graph();
  const n1 = g.addNode('start', 0, 0, { text: 'hello world' });
  const n2 = g.addNode('transform', 200, 0, { code: 'return (input||"").toUpperCase();' });
  const n3 = g.addNode('if', 400, 0, { op: 'contains', value: 'HELLO' });
  const n4 = g.addNode('llm', 600, 0, { mock: true, prompt: '处理：{{text}}' });
  const n5 = g.addNode('end', 800, 0, {});
  g.addEdge({ node: n1.id, port: 'text' }, { node: n2.id, port: 'input' });
  g.addEdge({ node: n2.id, port: 'output' }, { node: n3.id, port: 'text' });
  g.addEdge({ node: n3.id, port: 'true' }, { node: n4.id, port: 'text' });
  g.addEdge({ node: n4.id, port: 'text' }, { node: n5.id, port: 'text' });
  return { g, ids: { n1, n2, n3, n4, n5 } };
}

(async () => {
  let fail = 0;
  const assert = (cond, msg) => { if (!cond) { console.log('  ✗ ' + msg); fail++; } else { console.log('  ✓ ' + msg); } };

  // 1) 正常执行：条件走 true 分支
  {
    const { g, ids } = build();
    const eng = new Engine(g);
    const logs = [];
    const res = await eng.run({ onLog: (r) => logs.push(r), stepDelay: 0 });
    console.log('场景1：条件分支走 true');
    assert(res.ranCount === 5, '5 个节点全部执行 (' + res.ranCount + ')');
    assert(/LLM 模拟/.test(res.outputs[ids.n4.id].text), 'n4(LLM) 输出为模拟文本');
    assert(/处理：/.test(res.outputs[ids.n4.id].text), 'LLM 提示词模板 {{text}} 已替换');
    assert(logs.some((l) => l.text && l.text.includes('分支 → true')), '日志显示走了 true 分支');
  }

  // 2) 条件走 false：把输入改成不含 HELLO
  {
    const { g, ids } = build();
    g.getNode(ids.n1.id).config.text = 'goodbye';
    const eng = new Engine(g);
    const res = await eng.run({ stepDelay: 0 });
    console.log('场景2：条件分支走 false');
    assert(res.outputs[ids.n3.id].__branch === 'false', '分支为 false');
    assert(res.outputs[ids.n4.id] === undefined, 'false 分支下游的 n4 被剪枝、未执行');
  }

  // 3) 环检测
  {
    const { g, ids } = build();
    g.addEdge({ node: ids.n5.id, port: 'text' }, { node: ids.n1.id, port: 'text' });
    const eng = new Engine(g);
    let threw = false;
    try { await eng.run({ stepDelay: 0 }); } catch (e) { threw = /cycle/.test(e.message); }
    console.log('场景3：环检测');
    assert(threw, '存在环时抛出异常');
  }

  // 4) 多输入汇聚
  {
    const g = new Graph();
    const a = g.addNode('start', 0, 0, { text: 'A' });
    const b = g.addNode('start', 0, 120, { text: 'B' });
    const t = g.addNode('transform', 200, 60, { code: 'return (input||"").split(",").join("+");' });
    const end = g.addNode('end', 400, 60, {});
    g.addEdge({ node: a.id, port: 'text' }, { node: t.id, port: 'input' });
    g.addEdge({ node: b.id, port: 'text' }, { node: t.id, port: 'input' });
    g.addEdge({ node: t.id, port: 'output' }, { node: end.id, port: 'text' });
    const eng = new Engine(g);
    console.log('场景4：多输入汇聚（应等齐两路才执行）');
    // 无法直接断言顺序，但应 4 个节点都跑且 t 拿到 input
    const res = await eng.run({ stepDelay: 0 });
    assert(res.ranCount === 4, '4 个节点全部执行');
  }

  // 5) 条件合并：两条分支汇聚到同一个终点，被剪的那条不能堵死终点
  {
    const g = new Graph();
    const s = g.addNode('start', 0, 0, { text: '包含 18W 的句子' });
    const c = g.addNode('if', 200, 0, { op: 'contains', value: '18W' });
    const t1 = g.addNode('llm', 400, -80, { mock: true, prompt: '正常:{{text}}' });
    const t2 = g.addNode('llm', 400, 80, { mock: true, prompt: '异常:{{text}}' });
    const end = g.addNode('end', 620, 0, {});
    g.addEdge({ node: s.id, port: 'text' }, { node: c.id, port: 'text' });
    g.addEdge({ node: c.id, port: 'true' }, { node: t1.id, port: 'text' });
    g.addEdge({ node: c.id, port: 'false' }, { node: t2.id, port: 'text' });
    g.addEdge({ node: t1.id, port: 'text' }, { node: end.id, port: 'text' });
    g.addEdge({ node: t2.id, port: 'text' }, { node: end.id, port: 'text' });
    const eng = new Engine(g);
    let endInfo = null;
    const res = await eng.run({
      stepDelay: 0,
      onNodeDone: (id, info) => { if (id === end.id) endInfo = info; },
    });
    console.log('场景5：条件合并（终点应被已到的分支激活）');
    assert(res.outputs[end.id] !== undefined, '终点节点执行了（旧版会因入度不齐被堵死）');
    assert(res.ranCount === 4, '运行 4 个节点（' + res.ranCount + '）');
    assert(res.skippedCount === 1, '剪枝跳过 1 个（未选中的 LLM 分支）');
    assert(endInfo && typeof endInfo.inputs.text === 'string' && /LLM 模拟/.test(endInfo.inputs.text),
      '终点收到活分支的真实输出（旧版会被剪枝边的 undefined 覆盖成空）');
  }

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n失败 ${fail} 项 ❌`);
  process.exit(fail === 0 ? 0 : 1);
})();
