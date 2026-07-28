export interface UploadedFile {
  uploadKey: string;
  filename: string;
  mediaType: string;
  bytes: number;
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  const response = await fetch("/api/uploads", {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
      "x-file-size": String(file.size),
    },
    body: file,
  });
  const body = await response.json() as UploadedFile & { message?: string };
  if (!response.ok) throw new Error(body.message ?? "文件上传失败");
  return body;
}

export async function discardUploads(keys: string[]) {
  await Promise.all(keys.map((key) => fetch(`/api/uploads?key=${encodeURIComponent(key)}`, { method: "DELETE" })));
}
