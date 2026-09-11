// cloudflare:email's EmailMessage on Bun: the shape only. No send_email binding exists here, so nothing ever sends
// one; the mail plugin builds it all the same, which is what lets its tests run on Bun against a fake binding.
export class EmailMessage {
  constructor(public readonly from: string, public readonly to: string, public readonly raw: string | ReadableStream) {}
}
