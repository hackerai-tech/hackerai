export const mockLimit = jest.fn().mockResolvedValue({
  success: true,
  remaining: 10000,
  reset: Date.now() + 3600000,
  limit: 10000,
});

export class Ratelimit {
  constructor(_config: unknown) {}

  limit = mockLimit;

  static tokenBucket(_max: number, _interval: string, _refill: number) {
    return {};
  }

  static slidingWindow(_max: number, _interval: string) {
    return {};
  }
}

const ratelimitExports = { Ratelimit, mockLimit };
export default ratelimitExports;
