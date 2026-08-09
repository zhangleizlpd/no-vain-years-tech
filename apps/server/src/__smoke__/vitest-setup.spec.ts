import { describe, it, expect } from 'vitest';

describe('vitest setup smoke', () => {
  it('runs vitest under @nx/js:swc + Node env', () => {
    expect(1 + 1).toBe(2);
  });

  it('supports TS decorator metadata syntax', () => {
    function Decorator() {
      return function (_target: object, _key: string | symbol) {};
    }
    class Sample {
      @Decorator() field!: string;
    }
    expect(new Sample()).toBeInstanceOf(Sample);
  });
});
