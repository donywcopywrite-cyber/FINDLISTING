declare const process: {
  env: Record<string, string | undefined>;
};

interface Buffer extends Uint8Array {
  toString(encoding?: string): string;
}
interface BufferConstructor {
  from(data: string | ArrayBuffer | ArrayLike<number>): Buffer;
  concat(buffers: Buffer[]): Buffer;
}
declare const Buffer: BufferConstructor;

declare module 'http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    on(event: 'data', listener: (chunk: any) => void): IncomingMessage;
    on(event: 'end', listener: () => void): IncomingMessage;
    destroy(): void;
  }

  export interface ServerResponse {
    writeHead(statusCode: number, headers: Record<string, string>): void;
    end(body?: any): void;
  }

  export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

  export interface Server {
    listen(port: number, callback?: () => void): void;
  }

  export function createServer(listener: RequestListener): Server;

  const _default: {
    createServer: typeof createServer;
  };
  export default _default;
}
