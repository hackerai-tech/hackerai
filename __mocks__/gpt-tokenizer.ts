export const countTokens = jest.fn((text: string) => Math.ceil(text.length / 4));
export const encode = jest.fn((text: string) => new Array(Math.ceil(text.length / 4)).fill(0));
export const decode = jest.fn((_tokens: number[]) => 'decoded');
