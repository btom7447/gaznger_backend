import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

transporter.verify((err, success) => {
  if (err) {
    console.error("SMTP VERIFY FAILED:", err);
  } else {
    console.log("SMTP READY (Render)");
  }
});

export const sendOtpEmail = async (email: string, otp: string) => {
  try {
    await transporter.sendMail({
      from: `"Gaznger" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Your Gaznger Verification Code",
      text: `Your Gaznger verification code is ${otp}. This code expires in 10 minutes.`,
      html: `
    <div style="font-family: Arial, sans-serif;">
      <h2>Gaznger Email Verification</h2>
      <p>Your verification code is:</p>
      <h1 style="letter-spacing: 4px;">${otp}</h1>
      <p>This code expires in 10 minutes.</p>
      <p>If you didn’t request this, you can ignore this email.</p>
    </div>
  `,
    });

  } catch (err) {
    console.error("Error sending email:", err);
  }
};