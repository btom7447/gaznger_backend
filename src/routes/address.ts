import mongoose from "mongoose";
import { Router } from "express";
import User from "../models/User";
import Address from "../models/Address";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { createAddressSchema, updateAddressSchema } from "../validators/address.validators";

const router = Router();

// GET my addresses — includes isDefault computed from user.defaultAddress
router.get("/", requireAuth, async (req, res) => {
  try {
    const [user, addresses] = await Promise.all([
      User.findById(req.userId).lean(),
      Address.find({ user: req.userId }).sort({ createdAt: -1 }).lean(),
    ]);
    if (!user) return res.status(404).json({ message: "User not found" });

    const defaultId = user.defaultAddress?.toString();
    const result = addresses.map((a) => ({
      ...a,
      isDefault: a._id.toString() === defaultId,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch addresses" });
  }
});

// ADD a new address
router.post("/", requireAuth, validate(createAddressSchema), async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const address = await Address.create({ ...req.body, user: user._id });

    user.addressBook.push(address._id);
    const isFirstAddress = !user.defaultAddress;
    if (isFirstAddress) user.defaultAddress = address._id;
    await user.save();

    res.status(201).json({ ...address.toObject(), isDefault: isFirstAddress });
  } catch (err) {

    res.status(500).json({ message: "Failed to add address" });
  }
});

// UPDATE an address (ownership verified)
router.patch("/:addressId", requireAuth, validate(updateAddressSchema), async (req, res) => {
  try {
    const [address, user] = await Promise.all([
      Address.findOneAndUpdate(
        { _id: req.params.addressId, user: req.userId },
        req.body,
        { new: true }
      ),
      User.findById(req.userId).lean(),
    ]);
    if (!address) return res.status(404).json({ message: "Address not found" });
    const isDefault = user?.defaultAddress?.toString() === address._id.toString();
    res.json({ ...address.toObject(), isDefault });
  } catch (err) {

    res.status(500).json({ message: "Failed to update address" });
  }
});

// DELETE an address (ownership verified)
router.delete("/:addressId", requireAuth, async (req, res) => {
  try {
    const address = await Address.findOneAndDelete({
      _id: req.params.addressId,
      user: req.userId,
    });
    if (!address) return res.status(404).json({ message: "Address not found" });

    await User.findByIdAndUpdate(req.userId, {
      $pull: { addressBook: address._id },
    });

    const user = await User.findById(req.userId);
    if (user?.defaultAddress?.toString() === address._id.toString()) {
      user.defaultAddress = user.addressBook.length > 0 ? user.addressBook[0] : null;
      await user.save();
    }

    res.json({ message: "Address deleted" });
  } catch (err) {

    res.status(500).json({ message: "Failed to delete address" });
  }
});

// SET default address
router.patch("/default/:addressId", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const addressId = new mongoose.Types.ObjectId(req.params.addressId as string);

    if (!user.addressBook.some((id) => id.equals(addressId)))
      return res.status(400).json({ message: "Address does not belong to user" });

    user.defaultAddress = addressId;
    await user.save();

    res.json({ message: "Default address updated", defaultAddress: user.defaultAddress });
  } catch (err) {

    res.status(500).json({ message: "Failed to set default address" });
  }
});

export default router;
