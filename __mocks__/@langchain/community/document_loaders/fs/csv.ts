export const CSVLoader = jest.fn().mockImplementation(() => ({
  load: jest.fn().mockResolvedValue([]),
}));
