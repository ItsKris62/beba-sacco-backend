import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../../common/services/redis.service';
import * as fs from 'fs';
import * as path from 'path';

export interface RuleCondition {
  field: string;
  operator: 'gt' | 'lt' | 'eq' | 'neq' | 'gte' | 'lte' | 'in' | 'not_in';
  value: unknown;
}

export interface RiskRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  conditions: RuleCondition[];
  logic: 'AND' | 'OR';
  scoreImpact: number;
  flag: string;
}

export interface RuleSet {
  version: string;
  updatedAt: string;
  rules: RiskRule[];
}

export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  scoreImpact: number;
  flag?: string;
}

/**
 * Dynamic Rule Engine – Phase 6
 *
 * JSON-based rule evaluator that:
 *  1. Loads rules from `rules/risk.json` on startup
 *  2. Hot-reloads via Redis PubSub on `rules:reload` channel
 *  3. Evaluates conditions against a context object
 *
 * Rules file: backend/rules/risk.json
 * Hot-reload: publish `{"type":"RELOAD_RULES"}` to Redis channel `rules:reload`
 */
@Injectable()
export class DynamicRuleEngineService implements OnModuleInit {
  private readonly logger = new Logger(DynamicRuleEngineService.name);
  private readonly REDIS_CHANNEL = 'rules:reload';
  private readonly RULES_CACHE_KEY = 'rules:risk:current';
  private ruleSet: RuleSet | null = null;

  constructor(private readonly redis: RedisService) {}

  async onModuleInit(): Promise<void> {
    await this.loadRules();
    this.subscribeToHotReload();
  }

  private async loadRules(): Promise<void> {
    // Try Redis cache first (allows hot-reload without file change)
    const cached = await this.redis.getJson<RuleSet>(this.RULES_CACHE_KEY);
    if (cached) {
      this.ruleSet = cached;
      this.logger.log(`Loaded ${cached.rules.length} rules from Redis cache (v${cached.version})`);
      return;
    }

    // Fall back to file
    const rulesPath = path.join(process.cwd(), 'rules', 'risk.json');
    if (fs.existsSync(rulesPath)) {
      const raw = fs.readFileSync(rulesPath, 'utf-8');
      this.ruleSet = JSON.parse(raw) as RuleSet;
      this.logger.log(`Loaded ${this.ruleSet.rules.length} rules from file (v${this.ruleSet.version})`);
    } else {
      this.ruleSet = this.getDefaultRuleSet();
      this.logger.warn('rules/risk.json not found – using built-in defaults');
    }
  }

  private subscribeToHotReload(): void {
    const subscriber = this.redis.createSubscriber();
    subscriber.subscribe(this.REDIS_CHANNEL, (err) => {
      if (err) this.logger.error(`Rules reload subscribe error: ${err.message}`);
    });

    subscriber.on('message', async (_channel: string, message: string) => {
      try {
        const msg = JSON.parse(message) as { type: string; rules?: RuleSet };
        if (msg.type === 'RELOAD_RULES') {
          if (msg.rules) {
            this.ruleSet = msg.rules;
            await this.redis.setJson(this.RULES_CACHE_KEY, msg.rules, 86400);
            this.logger.log(`Hot-reloaded ${msg.rules.rules.length} rules (v${msg.rules.version})`);
          } else {
            await this.loadRules();
          }
        }
      } catch (err) {
        this.logger.warn(`Rules reload parse error: ${(err as Error).message}`);
      }
    });
  }

  evaluate(context: Record<string, unknown>): RuleEvaluationResult[] {
    if (!this.ruleSet) return [];

    return this.ruleSet.rules
      .filter((rule) => rule.enabled)
      .map((rule) => {
        const matched = this.evaluateRule(rule, context);
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          matched,
          scoreImpact: matched ? rule.scoreImpact : 0,
          flag: matched ? rule.flag : undefined,
        };
      });
  }

  private evaluateRule(rule: RiskRule, context: Record<string, unknown>): boolean {
    const results = rule.conditions.map((cond) => this.evaluateCondition(cond, context));
    return rule.logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  private evaluateCondition(cond: RuleCondition, context: Record<string, unknown>): boolean {
    const fieldValue = this.getNestedValue(context, cond.field);
    if (fieldValue === undefined) return false;

    switch (cond.operator) {
      case 'gt': return Number(fieldValue) > Number(cond.value);
      case 'lt': return Number(fieldValue) < Number(cond.value);
      case 'gte': return Number(fieldValue) >= Number(cond.value);
      case 'lte': return Number(fieldValue) <= Number(cond.value);
      case 'eq': return fieldValue === cond.value;
      case 'neq': return fieldValue !== cond.value;
      case 'in': return Array.isArray(cond.value) && (cond.value as unknown[]).includes(fieldValue);
      case 'not_in': return Array.isArray(cond.value) && !(cond.value as unknown[]).includes(fieldValue);
      default: return false;
    }
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  getRuleSet(): RuleSet | null {
    return this.ruleSet;
  }

  async publishRuleUpdate(rules: RuleSet): Promise<void> {
    await this.redis.setJson(this.RULES_CACHE_KEY, rules, 86400);
    await this.redis.publish(this.REDIS_CHANNEL, JSON.stringify({ type: 'RELOAD_RULES', rules }));
    this.logger.log(`Published rule update v${rules.version} to all instances`);
  }

  private getDefaultRuleSet(): RuleSet {
    return {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      rules: [
        {
          id: 'R001',
          name: 'High Transaction Amount',
          description: 'Flag transactions above KES 500,000',
          enabled: true,
          conditions: [{ field: 'amount', operator: 'gt', value: 500000 }],
          logic: 'AND',
          scoreImpact: 15,
          flag: 'HIGH_AMOUNT',
        },
        {
          id: 'R002',
          name: 'Multiple Failed Logins',
          description: 'Flag accounts with 3+ failed login attempts',
          enabled: true,
          conditions: [{ field: 'failedLoginAttempts', operator: 'gte', value: 3 }],
          logic: 'AND',
          scoreImpact: 20,
          flag: 'FAILED_LOGINS',
        },
        {
          id: 'R003',
          name: 'Cross-Region Login',
          description: 'Flag logins from different country than registration',
          enabled: true,
          conditions: [{ field: 'loginCountry', operator: 'neq', value: 'KE' }],
          logic: 'AND',
          scoreImpact: 25,
          flag: 'CROSS_REGION_LOGIN',
        },
      ],
    };
  }
}
