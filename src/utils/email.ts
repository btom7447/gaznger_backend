import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false, // TLS on port 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((err, success) => {
  if (err) console.log("SMTP connection error:", err);
  else console.log("SMTP ready to send messages");
});

export const sendOtpEmail = async (email: string, otp: string) => {
  try {
    await transporter.sendMail({
      from: `"Gaznger" <${process.env.SMTP_USER}>`, // must match Gmail user
      to: email,
      subject: "Your Gaznger OTP Code",
      text: `Your verification code is ${otp}. It expires in 10 minutes.`,
    });
  } catch (err) {
    console.error("Error sending email:", err);
  }
};