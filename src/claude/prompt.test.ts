import { describe, expect, it } from 'vitest';
import { recommend } from '../domain/allocation.ts';
import { assessHealth } from '../domain/health.ts';
import { formatMoney } from '../domain/money.ts';
import { CARD_A, CARD_B, CHECKING, LOAN, SNAPSHOT, STATE, withBalances } from '../domain/__fixtures__/state.ts';
import { allowedAccountIds, buildRequest, buildUserMessage, SYSTEM_PROMPT } from './prompt.ts';

const AS_OF = '2026-03-05';

function recommendationFixture() {
  return recommend(STATE, SNAPSHOT, AS_OF);
}

describe('system prompt', () => {
  it('states that arithmetic is settled, Claude must not compute, and quoted payments go in citedPayment', () => {
    expect(SYSTEM_PROMPT).toContain('ALREADY calculated the plan');
    expect(SYSTEM_PROMPT).toContain('NEVER calculate, estimate, adjust or infer a monetary figure');
    expect(SYSTEM_PROMPT).toContain('put it in the "citedPayment" field');
  });
});

describe('user message', () => {
  it('includes every settled figure Claude needs to explain without computing', () => {
    const recommendation = recommendationFixture();
    const health = assessHealth(STATE, SNAPSHOT, AS_OF);
    const message = buildUserMessage(recommendation, health);

    for (const payment of recommendation.primary.payments) {
      expect(message).toContain(`[id: ${payment.accountId}]`);
      expect(message).toContain(formatMoney(payment.amount));
      expect(message).toContain(formatMoney(payment.openingBalance));
      expect(message).toContain(formatMoney(payment.closingBalance));
    }
    expect(message).toContain(`Total allocated: ${formatMoney(recommendation.primary.totalAllocated)}`);
    expect(message).toContain(`Left unallocated in cash: ${formatMoney(recommendation.primary.leftOver)}`);
    expect(message).toContain(formatMoney(recommendation.primary.projectedMonthlyInterest));
    for (const alternative of recommendation.alternatives) {
      expect(message).toContain(alternative.strategy.name);
      expect(message).toContain(formatMoney(alternative.projectedMonthlyInterest));
    }
    expect(message).toContain(recommendation.whyPrimary);
    for (const assumption of recommendation.assumptions) expect(message).toContain(assumption);
  });

  it('lists every allowed account id in the required bracketed form', () => {
    const recommendation = recommendationFixture();
    const message = buildUserMessage(recommendation, null);

    expect(allowedAccountIds(recommendation)).toEqual([CARD_A, CARD_B, LOAN]);
    for (const accountId of allowedAccountIds(recommendation)) {
      expect(message).toContain(`[id: ${accountId}]`);
    }
    expect(message).not.toContain(`[id: ${CHECKING}]`);
  });

  it('warns explicitly when available funds do not cover contractual minimums', () => {
    const recommendation = recommend(STATE, withBalances({ [CHECKING]: '1100.00' }), AS_OF);

    expect(recommendation.primary.minimumsCovered).toBe(false);
    expect(buildUserMessage(recommendation, null)).toContain(
      `WARNING: available funds do not cover the contractual minimums; short by ${formatMoney(recommendation.primary.minimumsShortfall)}.`,
    );
  });

  it('omits the health section when no health report is supplied', () => {
    const message = buildUserMessage(recommendationFixture(), null);

    expect(message).not.toContain('Cash position:');
  });
});

describe('Claude request', () => {
  it('sets the requested model, a bounded response budget, and one user turn', () => {
    const recommendation = recommendationFixture();
    const request = buildRequest(recommendation, null, 'claude-3-7-sonnet-latest');

    expect(request.model).toBe('claude-3-7-sonnet-latest');
    expect(request.maxTokens).toBeGreaterThan(1000);
    expect(request.maxTokens).toBeLessThanOrEqual(4000);
    expect(request.messages).toEqual([
      { role: 'user', content: buildUserMessage(recommendation, null) },
    ]);
  });
});
