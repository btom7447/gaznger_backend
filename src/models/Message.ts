import mongoose, { Schema, Document } from "mongoose";

/**
 * A single chat message in a Chat thread.
 *
 * `system` messages are server-generated (e.g. "Order placed",
 * "Rider went online"). They have no `sender` and the client renders
 * them as centered pills, not bubbles.
 */
export interface IMessageAttachment {
  /** "image" or "video". Audio + file types may be added later. */
  kind: "image" | "video";
  /** Cloudinary secure_url. */
  url: string;
  /** Cloudinary thumb URL — first frame for video, smaller image for images. */
  thumbUrl?: string;
  /** Original dimensions for layout pre-calc. */
  width?: number;
  height?: number;
  /** Video duration in seconds when kind === "video". */
  durationSec?: number;
  /** mime/type as reported by the upload, e.g. "image/jpeg" / "video/mp4". */
  mime?: string;
}

export interface IMessage extends Document {
  chat: mongoose.Types.ObjectId;
  sender?: mongoose.Types.ObjectId;
  kind: "text" | "system";
  /** Body — may be empty when the message is attachment-only. */
  text: string;
  /**
   * Image / video attachments. Up to 9 per message — the client grid
   * caps at 9 (3×3) and merges extras into the body text count.
   */
  attachments: IMessageAttachment[];
  /**
   * Read-receipt timestamps per participant. Set when the participant
   * opens the thread or fires `chat:read`. Helps the sender's UI show
   * "read" vs "sent".
   */
  readBy: { user: mongoose.Types.ObjectId; at: Date }[];
  /**
   * Soft-delete marker. The row stays in Mongo so other participants'
   * threads aren't punched full of holes; the client renders a tombstone
   * bubble ("This message was deleted") when set.
   */
  deletedAt?: Date;
  /** User who triggered the deletion (sender or an admin). */
  deletedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const MessageAttachmentSchema = new Schema<IMessageAttachment>(
  {
    kind: { type: String, enum: ["image", "video"], required: true },
    url: { type: String, required: true },
    thumbUrl: { type: String },
    width: { type: Number },
    height: { type: Number },
    durationSec: { type: Number },
    mime: { type: String },
  },
  { _id: false },
);

const MessageSchema: Schema = new Schema(
  {
    chat: { type: Schema.Types.ObjectId, ref: "Chat", required: true },
    sender: { type: Schema.Types.ObjectId, ref: "User" },
    kind: {
      type: String,
      enum: ["text", "system"],
      default: "text",
    },
    // Text was `required: true` before attachments existed. With
    // attachments, a media-only message is valid — we default to ""
    // and rely on (text || attachments.length) as the validity check
    // at the route layer.
    text: { type: String, default: "", maxlength: 4000 },
    attachments: { type: [MessageAttachmentSchema], default: [] },
    readBy: [
      {
        _id: false,
        user: { type: Schema.Types.ObjectId, ref: "User", required: true },
        at: { type: Date, default: Date.now },
      },
    ],
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

MessageSchema.index({ chat: 1, createdAt: -1 });

export default mongoose.model<IMessage>("Message", MessageSchema);
