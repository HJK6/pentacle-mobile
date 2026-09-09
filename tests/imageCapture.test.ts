import { Alert } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import {
  MediaTooLargeError,
  captureImageFromCamera,
  compressForUpload,
  pickImagesFromLibrary,
  type ProcessedAsset,
} from '../src/services/imageCapture';

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  manipulateAsync: jest.fn(),
}));

const picker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const manipulator = ImageManipulator as jest.Mocked<typeof ImageManipulator>;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

function asset(overrides: Partial<ProcessedAsset> = {}): ProcessedAsset {
  return {
    uri: 'file:///photo.heic',
    fileName: 'photo.heic',
    mimeType: 'image/heic',
    width: 3000,
    height: 2000,
    bytes: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('compresses landscape, portrait, and dimensionless images as JPEG with measured bytes', async () => {
  manipulator.manipulateAsync
    .mockResolvedValueOnce({ uri: 'file:///landscape.jpg', width: 2000, height: 1333, base64: 'TWFu' })
    .mockResolvedValueOnce({ uri: 'file:///portrait.jpg', width: 1000, height: 2000, base64: 'TWE=' })
    .mockResolvedValueOnce({ uri: 'file:///unknown.jpg' } as never)
    .mockResolvedValueOnce({ uri: 'file:///wide.jpg', width: 2000 } as never)
    .mockResolvedValueOnce({ uri: 'file:///tall.jpg', height: 2000 } as never);

  await expect(compressForUpload(asset())).resolves.toEqual({
    uri: 'file:///landscape.jpg',
    fileName: 'photo.heic',
    mimeType: 'image/jpeg',
    width: 2000,
    height: 1333,
    bytes: 3,
  });
  await expect(compressForUpload(asset({ width: 1000, height: 3000 }))).resolves.toEqual(expect.objectContaining({
    uri: 'file:///portrait.jpg',
    bytes: 2,
  }));
  await expect(compressForUpload(asset({ width: null, height: null }))).resolves.toEqual(expect.objectContaining({
    uri: 'file:///unknown.jpg',
    width: null,
    height: null,
    bytes: 0,
  }));
  await compressForUpload(asset({ width: 3000, height: null }));
  await compressForUpload(asset({ width: null, height: 3000 }));

  expect(manipulator.manipulateAsync).toHaveBeenNthCalledWith(1, 'file:///photo.heic', [{ resize: { width: 2000 } }], {
    compress: 0.7,
    format: 'jpeg',
    base64: true,
  });
  expect(manipulator.manipulateAsync).toHaveBeenNthCalledWith(2, 'file:///photo.heic', [{ resize: { height: 2000 } }], expect.any(Object));
  expect(manipulator.manipulateAsync).toHaveBeenNthCalledWith(3, 'file:///photo.heic', [], expect.any(Object));
  expect(manipulator.manipulateAsync).toHaveBeenNthCalledWith(4, 'file:///photo.heic', [{ resize: { width: 2000 } }], expect.any(Object));
  expect(manipulator.manipulateAsync).toHaveBeenNthCalledWith(5, 'file:///photo.heic', [{ resize: { height: 2000 } }], expect.any(Object));
});

test('retries oversized media once and rejects a still-oversized upload with measured evidence', async () => {
  const oversized = 'A'.repeat(5_592_408);
  manipulator.manipulateAsync
    .mockResolvedValueOnce({ uri: 'file:///large.jpg', width: 2000, height: 1500, base64: oversized })
    .mockResolvedValueOnce({ uri: 'file:///retry.jpg', width: 1280, height: 960, base64: 'TQ==' });

  await expect(compressForUpload(asset())).resolves.toEqual(expect.objectContaining({
    uri: 'file:///retry.jpg',
    width: 1280,
    height: 960,
    bytes: 1,
  }));
  expect(manipulator.manipulateAsync).toHaveBeenNthCalledWith(2, 'file:///photo.heic', [{ resize: { width: 1280 } }], {
    compress: 0.5,
    format: 'jpeg',
    base64: true,
  });

  manipulator.manipulateAsync
    .mockResolvedValueOnce({ uri: 'file:///large.jpg', width: 2000, height: 1500, base64: oversized })
    .mockResolvedValueOnce({ uri: 'file:///still-large.jpg', width: 1280, height: 960, base64: oversized });
  const rejected = compressForUpload(asset());
  await expect(rejected).rejects.toBeInstanceOf(MediaTooLargeError);
  await expect(rejected).rejects.toMatchObject({ name: 'MediaTooLargeError', bytes: 4_194_306 });
});

test('library picker enforces the remaining-slot cap and normalizes selected media', async () => {
  await expect(pickImagesFromLibrary(0)).resolves.toEqual([]);
  expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();

  picker.requestMediaLibraryPermissionsAsync.mockResolvedValueOnce({ granted: false } as never);
  await expect(pickImagesFromLibrary(2)).resolves.toEqual([]);
  expect(alertSpy).toHaveBeenCalledWith('Photo access needed', 'Allow photo library access to attach photos.');

  picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true } as never);
  picker.launchImageLibraryAsync
    .mockResolvedValueOnce({ canceled: true, assets: null } as never)
    .mockResolvedValueOnce({ canceled: false, assets: [] } as never)
    .mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: 'file:///one.png', fileName: 'one.png', width: 10, height: 20 },
        { uri: 'file:///two', fileName: null, width: null, height: null },
        { uri: 'file:///three.jpg', fileName: 'three.jpg', width: 30, height: 40 },
      ],
    } as never);
  await expect(pickImagesFromLibrary(2)).resolves.toEqual([]);
  await expect(pickImagesFromLibrary(2)).resolves.toEqual([]);
  await expect(pickImagesFromLibrary(2)).resolves.toEqual([
    { uri: 'file:///one.png', fileName: 'one.jpg', mimeType: 'image/jpeg', width: 10, height: 20, bytes: 0 },
    { uri: 'file:///two', fileName: 'chat-image.jpg', mimeType: 'image/jpeg', width: null, height: null, bytes: 0 },
  ]);
  expect(picker.launchImageLibraryAsync).toHaveBeenLastCalledWith({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 2,
    quality: 0.9,
  });
});

test('camera permission and cancellation never fabricate an attachment', async () => {
  picker.requestCameraPermissionsAsync
    .mockResolvedValueOnce({ granted: false } as never)
    .mockResolvedValue({ granted: true } as never);
  await expect(captureImageFromCamera()).resolves.toBeNull();
  expect(alertSpy).toHaveBeenCalledWith('Camera access needed', 'Allow camera access to take a photo.');

  picker.launchCameraAsync
    .mockResolvedValueOnce({ canceled: true, assets: null } as never)
    .mockResolvedValueOnce({ canceled: false, assets: [] } as never)
    .mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///camera.jpeg', fileName: 'camera.jpeg', width: 640, height: 480 }],
    } as never);
  await expect(captureImageFromCamera()).resolves.toBeNull();
  await expect(captureImageFromCamera()).resolves.toBeNull();
  await expect(captureImageFromCamera()).resolves.toEqual({
    uri: 'file:///camera.jpeg',
    fileName: 'camera.jpg',
    mimeType: 'image/jpeg',
    width: 640,
    height: 480,
    bytes: 0,
  });
  expect(picker.launchCameraAsync).toHaveBeenLastCalledWith({ mediaTypes: ['images'], quality: 0.9 });
});
