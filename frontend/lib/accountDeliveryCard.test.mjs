import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAccountDeliveryConfig,
  displayDuration,
  isInternalAccountDeliveryCard,
  parseDuration,
  readAccountDeliveryCard,
} from './accountDeliveryCard.ts';

const card = {
  id: 1,
  type: 'api',
  api_config: {
    url: 'http://delivery-gateway:8081/api/delivery/codes',
    method: 'POST',
    timeout: 10,
    headers: JSON.stringify({ Authorization: 'Bearer synthetic-test-secret', 'Content-Type': 'application/json' }),
    params: JSON.stringify({
      shopId: '{cookie_id}',
      orderId: '{order_id}',
      itemId: '{item_id}',
      deliveryIndex: '{delivery_index}',
      poolId: '00000000-0000-4000-8000-000000000001',
      durationMinutes: 120,
    }),
  },
};

test('recognizes existing account delivery cards and changes only selected pool and duration', () => {
  assert.deepEqual(readAccountDeliveryCard(card), {
    poolId: '00000000-0000-4000-8000-000000000001',
    durationMinutes: 120,
  });
  const copied = buildAccountDeliveryConfig(card, '00000000-0000-4000-8000-000000000002', 180);
  assert.equal(copied.url, card.api_config.url);
  assert.equal(copied.headers, card.api_config.headers);
  assert.equal(copied.method, 'POST');
  assert.equal(copied.timeout, 10);
  assert.deepEqual(JSON.parse(copied.params), {
    ...JSON.parse(card.api_config.params),
    poolId: '00000000-0000-4000-8000-000000000002',
    durationMinutes: 180,
  });
  assert.deepEqual(readAccountDeliveryCard({ ...card, api_config: copied }), {
    poolId: '00000000-0000-4000-8000-000000000002',
    durationMinutes: 180,
  });
  assert.equal(JSON.parse(card.api_config.params).poolId, '00000000-0000-4000-8000-000000000001');
  assert.equal(JSON.parse(card.api_config.params).durationMinutes, 120);
});

test('rejects incomplete templates and invalid durations', () => {
  const broken = {
    ...card,
    api_config: {
      ...card.api_config,
      params: JSON.stringify({ ...JSON.parse(card.api_config.params), deliveryIndex: '1' }),
    },
  };
  assert.equal(readAccountDeliveryCard(broken), null);
  assert.throws(() => buildAccountDeliveryConfig(broken, 'pool-id', 60));
  assert.throws(() => buildAccountDeliveryConfig(card, '', 60));
  assert.throws(() => buildAccountDeliveryConfig(card, 'pool-id', 0));
  assert.throws(() => buildAccountDeliveryConfig(card, 'pool-id', 525601));
});

test('only the exact internal gateway connection can seed a new managed card', () => {
  assert.equal(isInternalAccountDeliveryCard(card), true);
  const legacyPublicCard = {
    ...card,
    api_config: { ...card.api_config, url: 'https://example.com/api/delivery/codes' },
  };
  assert.deepEqual(readAccountDeliveryCard(legacyPublicCard), {
    poolId: '00000000-0000-4000-8000-000000000001',
    durationMinutes: 120,
  });
  assert.equal(isInternalAccountDeliveryCard(legacyPublicCard), false);
  assert.equal(isInternalAccountDeliveryCard({
    ...card,
    api_config: { ...card.api_config, url: 'http://delivery-gateway:8081/api/delivery/codes?redirect=1' },
  }), false);
});

test('converts operator time units to whole minutes', () => {
  assert.deepEqual(displayDuration(120), { amount: '2', unit: 'hours' });
  assert.deepEqual(displayDuration(1440), { amount: '1', unit: 'days' });
  assert.deepEqual(displayDuration(90), { amount: '90', unit: 'minutes' });
  assert.equal(parseDuration('2', 'hours'), 120);
  assert.equal(parseDuration('1', 'days'), 1440);
  assert.equal(parseDuration('1.5', 'hours'), 90);
  assert.equal(parseDuration('1.5', 'minutes'), null);
  assert.equal(parseDuration('', 'hours'), null);
});
