import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  collectPayloadArtifacts,
  PayloadObservations,
} from './payload-observation.mjs';
const node = (dataset) => ({
  isConnected: true,
  dataset,
  classList: { contains: (n) => n === 'pdfDocumentRobotArrival' },
});
const sample = (nodes, plans, count) => ({
  payloadArtifacts: collectPayloadArtifacts({ querySelectorAll: () => nodes }),
  robots: { pages: [], deliveryPlans: plans, queuedDeliveryCovers: count },
});
const plan = [{ id: 1, crops: [{ id: 0, state: 'queued', protected: true }] }];
test('queued cover ownership is complete and cleans up', () => {
  const observer = new PayloadObservations();
  assert.doesNotThrow(() =>
    observer.observe(
      sample([node({ deliveryPlan: '1', deliveryCrop: '0' })], plan, 1),
    ),
  );
  assert.doesNotThrow(() => observer.observe(sample([], [], 0)));
});
const invalidCases = [
  { name: 'unowned cover', nodes: [node({})], plans: plan, count: 1 },
  {
    name: 'duplicate plan crop',
    nodes: [
      node({ deliveryPlan: '1', deliveryCrop: '0' }),
      node({ deliveryPlan: '1', deliveryCrop: '0' }),
    ],
    plans: plan,
    count: 1,
  },
  {
    name: 'mixed payload and plan ownership',
    nodes: [node({ deliveryPlan: '1', deliveryCrop: '0', payload: '2' })],
    plans: plan,
    count: 1,
  },
  {
    name: 'stale cover without a current plan',
    nodes: [node({ deliveryPlan: '1', deliveryCrop: '0' })],
    plans: [],
    count: 0,
  },
  { name: 'missing protected cover', nodes: [], plans: plan, count: 1 },
  {
    name: 'incorrect queued resource total',
    nodes: [node({ deliveryPlan: '1', deliveryCrop: '0' })],
    plans: plan,
    count: 0,
  },
];
for (const { name, nodes, plans, count } of invalidCases) {
  test('rejects ' + name, () => {
    assert.throws(() =>
      new PayloadObservations().observe(sample(nodes, plans, count)),
    );
  });
}

test('queued protection hands off exclusively to a payload and retirement removes pixels', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL('./fixtures/refine-then-retire.json', import.meta.url),
    ),
  );
  const observer = new PayloadObservations();
  observer.observe(
    sample([node({ deliveryPlan: '1', deliveryCrop: '0' })], plan, 1),
  );
  const active = sample(
    [node({ payload: String(fixture.before.id) })],
    [{ id: 1, crops: [{ id: 0, state: 'active', protected: false }] }],
    0,
  );
  active.robots.pages = [{ page: fixture.page, payloads: [fixture.before] }];
  observer.observe(active);
  const retired = sample([], [], 0);
  retired.robots.pages = [{ page: fixture.page, payloads: [fixture.after] }];
  observer.observe(retired);
  assert.throws(
    () =>
      observer.observe({
        ...retired,
        payloadArtifacts: collectPayloadArtifacts({
          querySelectorAll: () => [
            node({ payload: String(fixture.before.id) }),
          ],
        }),
      }),
    /artifact/,
  );
});
