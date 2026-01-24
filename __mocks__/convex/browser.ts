export const mockQuery = jest.fn().mockResolvedValue({});
export const mockMutation = jest
  .fn()
  .mockResolvedValue({ success: true, newBalanceDollars: 10 });
export const mockAction = jest.fn().mockResolvedValue({
  success: true,
  newBalanceDollars: 10,
  insufficientFunds: false,
  monthlyCapExceeded: false,
});

export class ConvexHttpClient {
  constructor(_url: string) {}

  query = mockQuery;
  mutation = mockMutation;
  action = mockAction;
}

const convexExports = { ConvexHttpClient, mockQuery, mockMutation, mockAction };
export default convexExports;
