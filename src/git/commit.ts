import { z } from "zod";
import { ShaSchema } from "../core/schemas/common.js";
import type { GitRunner } from "./runner.js";
import { type Signer, SshSignatureSchema } from "./signer.js";

export interface Ident {
  name: string;
  email: string;
  timestampSec: number;
  tz: string;
}

interface CommitFields {
  tree: string;
  parents: string[];
  author: Ident;
  committer: Ident;
  message: string;
}

const IdentSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .refine((name) => !/[<>\r\n\0]/.test(name), "invalid identity name"),
  email: z
    .string()
    .min(1)
    .refine((email) => !/[<>\s\0]/.test(email), "invalid identity email"),
  timestampSec: z.number().int().nonnegative(),
  tz: z
    .string()
    .length(5)
    .regex(/^[+-](?:[01]\d|2[0-3])[0-5]\d$/),
});

// Shared SHA_RE uses '$', which also matches before a final LF; reject it at this I/O boundary.
const ObjectIdSchema = ShaSchema.refine(
  (sha) => !sha.includes("\n"),
  "object ID cannot contain LF",
);

const CommitFieldsSchema = z.strictObject({
  tree: ObjectIdSchema,
  parents: z.array(ObjectIdSchema),
  author: IdentSchema,
  committer: IdentSchema,
  message: z.string().refine((message) => !message.includes("\0"), "message cannot contain NUL"),
});

function identText(ident: Ident): string {
  return `${ident.name} <${ident.email}> ${ident.timestampSec} ${ident.tz}`;
}

export function buildCommitText(fields: CommitFields): string {
  const { tree, parents, author, committer, message } = CommitFieldsSchema.parse(fields);
  const headers = [
    `tree ${tree}`,
    ...parents.map((parent) => `parent ${parent}`),
    `author ${identText(author)}`,
    `committer ${identText(committer)}`,
  ];
  return `${headers.join("\n")}\n\n${message}${message.endsWith("\n") ? "" : "\n"}`;
}

export function insertSignature(commitText: string, armoredSig: string): string {
  const signature = SshSignatureSchema.parse(armoredSig).replace(/\n$/, "");
  const boundary = commitText.indexOf("\n\n");
  if (boundary === -1 || /^gpgsig(?:-sha256)? /m.test(commitText.slice(0, boundary))) {
    throw new TypeError("Expected an unsigned commit with a header/message separator");
  }
  // ARCHITECTURE §7.3: the signed payload excludes this folded header, including its prefix spaces.
  const header = `gpgsig ${signature.split("\n").join("\n ")}`;
  return `${commitText.slice(0, boundary)}\n${header}${commitText.slice(boundary)}`;
}

export async function writeSignedCommit(
  git: GitRunner,
  repoDir: string,
  { signer, ...fields }: CommitFields & { signer: Signer },
): Promise<string> {
  const text = buildCommitText(fields);
  const signature = await signer.sign(Buffer.from(text, "utf8"));
  const { stdout } = await git.run(["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd: repoDir,
    input: insertSignature(text, signature),
  });
  return ShaSchema.parse(stdout.trim());
}

export async function writeTreeFromIndex(git: GitRunner, repoDir: string): Promise<string> {
  const { stdout } = await git.run(["write-tree"], { cwd: repoDir });
  return ShaSchema.parse(stdout.trim());
}
