const mockSend = jest.fn();

export const S3Client = jest.fn().mockImplementation((config: any) => ({
  send: mockSend,
}));

export class PutObjectCommand {
  constructor(params: any) {}
}

export class GetObjectCommand {
  constructor(params: any) {}
}

export class DeleteObjectCommand {
  constructor(params: any) {}
}
