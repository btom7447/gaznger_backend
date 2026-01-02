import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false, // true if using 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const sendOtpEmail = async (email: string, otp: string) => {
  try {
    await transporter.sendMail({
      from: `"Gaznger" <no-reply@gaznger.com>`,
      to: email,
      subject: "Your Gaznger OTP Code",
      text: `Your verification code is ${otp}. It expires in 10 minutes.`,
    });
  } catch (err) {
    console.error("Error sending email:", err);
  }
};
