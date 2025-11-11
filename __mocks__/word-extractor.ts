const WordExtractor = jest.fn().mockImplementation(() => ({
  extract: jest.fn(),
}));

export default WordExtractor;
