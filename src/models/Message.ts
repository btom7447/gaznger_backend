import mongoose, { Schema, Document } from "mongoose";

/**
 * A single chat message in a Chat thread.
 *
 * `system` messages are server-generated (e.g. "Order placed",
 * "Rider went online"). They have no `sender` and the client renders
 * them as centered pills, not bubbles.
 */
export interface IMessage extends Document {
  chat: mongoose.Types.ObjectId;
  sender?: mongoose.Types.ObjectId;
  kind: "text" | "system";
  text: string;
  /**
   * Read-receipt timestamps per participant. Set when the participant
   * opens the thread or fires `chat:read`. Helps the sender's UI show
   * "read" vs "sent".
   */
  readBy: { user: mongoose.Types.ObjectId; at: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema: Schema = new Schema(
  {
    chat: { type: Schema.Types.ObjectId, ref: "Chat", required: true },
    sender: { type: Schema.Types.ObjectId, ref: "User" },
    kind: {
      type: String,
      enum: ["text", "system"],
      default: "text",
    },
    text: { type: String, required: true, maxlength: 4000 },
    readBy: [
      {
        _id: false,
        user: { type: Schema.Types.ObjectId, ref: "User", required: true },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

MessageSchema.index({ chat: 1, createdAt: -1 });

export default mongoose.model<IMessage>("Message", MessageSchema);
