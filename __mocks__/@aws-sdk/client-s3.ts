const mockSend = jest.fn();

export const S3Client = jest.fn().mockImplementation((config: any) => ({
  send: mockSend,
}));

export const PutObjectCommand = jest.fn().mockImplementation((params: any) => ({
  params,
}));

export class GetObjectCommand {
  constructor(params: any) {}
}

export class DeleteObjectCommand {
  constructor(params: any) {}
}

export class HeadObjectCommand {
  constructor(params: any) {}
}
