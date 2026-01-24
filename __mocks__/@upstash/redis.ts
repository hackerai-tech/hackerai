export const mockHincrby = jest.fn().mockResolvedValue(5000);
export const mockHset = jest.fn().mockResolvedValue(1);
export const mockHget = jest.fn().mockResolvedValue(null);
export const mockGet = jest.fn().mockResolvedValue(null);
export const mockSet = jest.fn().mockResolvedValue("OK");
export const mockDel = jest.fn().mockResolvedValue(1);
export const mockIncr = jest.fn().mockResolvedValue(1);
export const mockDecr = jest.fn().mockResolvedValue(0);

export class Redis {
  hincrby = mockHincrby;
  hset = mockHset;
  hget = mockHget;
  get = mockGet;
  set = mockSet;
  del = mockDel;
  incr = mockIncr;
  decr = mockDecr;
}

const redisExports = {
  Redis,
  mockHincrby,
  mockHset,
  mockHget,
  mockGet,
  mockSet,
  mockDel,
  mockIncr,
  mockDecr,
};
export default redisExports;
