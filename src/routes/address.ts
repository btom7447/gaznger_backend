import mongoose from "mongoose";
import { Router } from "express";
import User from "../models/User";
import Address, { IAddress } from "../models/Address";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: AddressBook
 *   description: User address book management
 */

/**
 * @swagger
 * /api/address-book/{userId}:
 *   get:
 *     summary: Get all addresses for a user
 *     tags: [AddressBook]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: The user's ID
 *     responses:
 *       200:
 *         description: Array of addresses
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Address'
 *       500:
 *         description: Server error
 */
router.get("/:userId", async (req, res) => {
  try {
    const addresses = await Address.find({ user: req.params.userId }).sort({
      createdAt: -1,
    });
    res.json(addresses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch addresses" });
  }
});

/**
 * @swagger
 * /api/address-book/{userId}:
 *   post:
 *     summary: Add a new address for a user
 *     tags: [AddressBook]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: The user's ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AddressInput'
 *     responses:
 *       201:
 *         description: Address created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Address'
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post("/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const addressData = {
      ...req.body,
      user: user._id,
    };

    const address = await Address.create(addressData);

    // Add to user's addressBook array
    user.addressBook.push(address._id);

    // If user has no defaultAddress yet, set this as default
    if (!user.defaultAddress) {
      user.defaultAddress = address._id;
    }

    await user.save();

    res.status(201).json(address);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add address" });
  }
});

/**
 * @swagger
 * /api/address-book/{addressId}:
 *   patch:
 *     summary: Update an existing address
 *     tags: [AddressBook]
 *     parameters:
 *       - in: path
 *         name: addressId
 *         required: true
 *         schema:
 *           type: string
 *         description: Address ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AddressInput'
 *     responses:
 *       200:
 *         description: Updated address
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Address'
 *       404:
 *         description: Address not found
 *       500:
 *         description: Server error
 */
router.patch("/:addressId", async (req, res) => {
  try {
    const address = await Address.findByIdAndUpdate(
      req.params.addressId,
      req.body,
      { new: true }
    );
    if (!address) return res.status(404).json({ message: "Address not found" });
    res.json(address);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update address" });
  }
});

/**
 * @swagger
 * /api/address-book/{addressId}:
 *   delete:
 *     summary: Delete an address
 *     tags: [AddressBook]
 *     parameters:
 *       - in: path
 *         name: addressId
 *         required: true
 *         schema:
 *           type: string
 *         description: Address ID
 *     responses:
 *       200:
 *         description: Address deleted
 *       404:
 *         description: Address not found
 *       500:
 *         description: Server error
 */
router.delete("/:addressId", async (req, res) => {
  try {
    const address = await Address.findByIdAndDelete(req.params.addressId);
    if (!address) return res.status(404).json({ message: "Address not found" });

    // Remove from user's addressBook
    await User.findByIdAndUpdate(address.user, {
      $pull: { addressBook: address._id },
    });

    // If it was the default address, clear it
    const user = await User.findById(address.user);
    if (user?.defaultAddress?.toString() === address._id.toString()) {
      user.defaultAddress =
        user.addressBook.length > 0 ? user.addressBook[0] : null;
      await user.save();
    }

    res.json({ message: "Address deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete address" });
  }
});

/**
 * @swagger
 * /api/address-book/{userId}/default/{addressId}:
 *   patch:
 *     summary: Set an address as the default for the user
 *     tags: [AddressBook]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *       - in: path
 *         name: addressId
 *         required: true
 *         schema:
 *           type: string
 *         description: Address ID
 *     responses:
 *       200:
 *         description: Default address updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 defaultAddress:
 *                   type: string
 *       400:
 *         description: Address does not belong to user
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.patch("/:userId/default/:addressId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const addressId = new mongoose.Types.ObjectId(req.params.addressId);

    // Ensure the address belongs to this user
    if (!user.addressBook.some((id) => id.equals(addressId)))
      return res
        .status(400)
        .json({ message: "Address does not belong to user" });

    user.defaultAddress = addressId;
    await user.save();

    res.json({
      message: "Default address updated",
      defaultAddress: user.defaultAddress,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to set default address" });
  }
});

export default router;

/**
 * @swagger
 * components:
 *   schemas:
 *     Address:
 *       type: object
 *       properties:
 *         _id:
 *           type: string
 *         user:
 *           type: string
 *         label:
 *           type: string
 *         street:
 *           type: string
 *         city:
 *           type: string
 *         state:
 *           type: string
 *         country:
 *           type: string
 *         postalCode:
 *           type: string
 *         latitude:
 *           type: number
 *         longitude:
 *           type: number
 *         icon:
 *           type: string
 *           description: Ionicons icon name
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 *     AddressInput:
 *       type: object
 *       properties:
 *         label:
 *           type: string
 *         street:
 *           type: string
 *         city:
 *           type: string
 *         state:
 *           type: string
 *         country:
 *           type: string
 *         postalCode:
 *           type: string
 *         latitude:
 *           type: number
 *         longitude:
 *           type: number
 *         icon:
 *           type: string
 *           description: Ionicons icon name
 *           default: home-outline
 */