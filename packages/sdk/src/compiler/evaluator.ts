/**
 * Tree-walking evaluator for compiled AST expressions.
 *
 * @module compiler/evaluator
 */

import type { ASTNode, PathSegment } from './ast.js';
import { astDepth } from './ast.js';
import { isSafePattern } from '../deterministic/regex-safety.js';

const MAX_DEPTH = 50;

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}

export type EvalContext = Record<string, unknown>;

export function evaluate(node: ASTNode, ctx: EvalContext): unknown {
  const depth = astDepth(node);
  if (depth > MAX_DEPTH) {
    throw new EvaluationError(`AST depth ${depth} exceeds maximum of ${MAX_DEPTH}`);
  }
  return evalNode(node, ctx);
}

function evalNode(node: ASTNode, ctx: EvalContext): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;

    case 'path':
      return resolvePath(node.segments, ctx);

    case 'unary':
      return evalUnary(node.op, evalNode(node.operand, ctx));

    case 'binary':
      return evalBinary(node.op, node.left, node.right, ctx);

    case 'call':
      return evalCall(node.name, node.args, ctx);
  }
}

function resolvePath(segments: PathSegment[], ctx: EvalContext): unknown {
  let current: unknown = ctx;

  for (const seg of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    switch (seg.type) {
      case 'field':
        if (typeof current !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(current, seg.name)) return undefined;
        current = (current as Record<string, unknown>)[seg.name];
        break;

      case 'index':
        if (!Array.isArray(current)) return undefined;
        current = current[seg.value];
        break;

      case 'wildcard':
        if (!Array.isArray(current)) return undefined;
        return current;
    }
  }

  return current;
}

function evalUnary(op: string, val: unknown): unknown {
  switch (op) {
    case '!':
      return !val;
    case '-':
      if (typeof val !== 'number') {
        throw new EvaluationError(`Cannot negate non-number: ${typeof val}`);
      }
      return -val;
    default:
      throw new EvaluationError(`Unknown unary operator: ${op}`);
  }
}

function evalBinary(
  op: string,
  leftNode: ASTNode,
  rightNode: ASTNode,
  ctx: EvalContext,
): unknown {
  // Short-circuit for logical operators
  if (op === '&&') {
    const left = evalNode(leftNode, ctx);
    if (!left) return left;
    return evalNode(rightNode, ctx);
  }
  if (op === '||') {
    const left = evalNode(leftNode, ctx);
    if (left) return left;
    return evalNode(rightNode, ctx);
  }

  const left = evalNode(leftNode, ctx);
  const right = evalNode(rightNode, ctx);

  switch (op) {
    case '+':
      if (typeof left === 'string' || typeof right === 'string') {
        return String(left) + String(right);
      }
      return toNumber(left) + toNumber(right);
    case '-':
      return toNumber(left) - toNumber(right);
    case '*':
      return toNumber(left) * toNumber(right);
    case '/': {
      const divisor = toNumber(right);
      if (divisor === 0) {
        throw new EvaluationError('Division by zero');
      }
      return toNumber(left) / divisor;
    }
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return toNumber(left) < toNumber(right);
    case '>':
      return toNumber(left) > toNumber(right);
    case '<=':
      return toNumber(left) <= toNumber(right);
    case '>=':
      return toNumber(left) >= toNumber(right);
    case 'in':
      if (!Array.isArray(right)) {
        throw new EvaluationError(`'in' requires an array on the right side`);
      }
      return right.includes(left);
    case 'not_in':
      if (!Array.isArray(right)) {
        throw new EvaluationError(`'not_in' requires an array on the right side`);
      }
      return !right.includes(left);
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string') {
        return left.includes(right);
      }
      if (Array.isArray(left)) {
        return left.includes(right);
      }
      throw new EvaluationError(`'contains' requires a string or array on the left side`);
    case 'matches': {
      if (typeof left !== 'string' || typeof right !== 'string') {
        throw new EvaluationError(`'matches' requires strings on both sides`);
      }
      if (!isSafePattern(right)) {
        throw new EvaluationError(`'matches' pattern failed safety check`);
      }
      const re = new RegExp(right);
      return re.test(left);
    }
    default:
      throw new EvaluationError(`Unknown binary operator: ${op}`);
  }
}

function evalCall(name: string, argNodes: ASTNode[], ctx: EvalContext): unknown {
  const args = argNodes.map((a) => evalNode(a, ctx));

  switch (name) {
    case 'len':
      if (args.length !== 1) throw new EvaluationError(`len() takes 1 argument, got ${args.length}`);
      if (typeof args[0] === 'string') return args[0].length;
      if (Array.isArray(args[0])) return args[0].length;
      throw new EvaluationError(`len() requires a string or array argument`);

    case 'lower':
      if (args.length !== 1) throw new EvaluationError(`lower() takes 1 argument, got ${args.length}`);
      if (typeof args[0] !== 'string') throw new EvaluationError(`lower() requires a string argument`);
      return args[0].toLowerCase();

    case 'upper':
      if (args.length !== 1) throw new EvaluationError(`upper() takes 1 argument, got ${args.length}`);
      if (typeof args[0] !== 'string') throw new EvaluationError(`upper() requires a string argument`);
      return args[0].toUpperCase();

    case 'abs':
      if (args.length !== 1) throw new EvaluationError(`abs() takes 1 argument, got ${args.length}`);
      return Math.abs(toNumber(args[0]));

    case 'min':
      if (args.length < 2) throw new EvaluationError(`min() takes at least 2 arguments`);
      return Math.min(...args.map(toNumber));

    case 'max':
      if (args.length < 2) throw new EvaluationError(`max() takes at least 2 arguments`);
      return Math.max(...args.map(toNumber));

    case 'starts_with':
      if (args.length !== 2) throw new EvaluationError(`starts_with() takes 2 arguments`);
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string') {
        throw new EvaluationError(`starts_with() requires string arguments`);
      }
      return args[0].startsWith(args[1]);

    case 'ends_with':
      if (args.length !== 2) throw new EvaluationError(`ends_with() takes 2 arguments`);
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string') {
        throw new EvaluationError(`ends_with() requires string arguments`);
      }
      return args[0].endsWith(args[1]);

    default:
      throw new EvaluationError(`Unknown function: ${name}()`);
  }
}

function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    if (isNaN(n)) {
      throw new EvaluationError(`Cannot convert string '${val}' to number`);
    }
    return n;
  }
  if (typeof val === 'boolean') return val ? 1 : 0;
  throw new EvaluationError(`Cannot convert ${typeof val} to number`);
}
