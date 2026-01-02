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
      from: `"Gaznger" <${process.env.SMTP_USER}>`, // must match Gmail user
      to: email,
      subject: "Your Gaznger OTP Code",
      text: `Your verification code is ${otp}. It expires in 10 minutes.`,
    });
  } catch (err) {
    console.error("Error sending email:", err);
  }
};