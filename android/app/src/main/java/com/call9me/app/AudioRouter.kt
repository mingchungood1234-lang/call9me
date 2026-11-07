package com.call9me.app

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * Where call audio plays: the loudspeaker, or the earpiece / a headset (wired, USB or Bluetooth,
 * whichever is connected). Video calls start on the loudspeaker, voice calls at the ear, and a
 * connected headset always wins at the start.
 */
object AudioRouter {
    private val HEADSETS = setOf(
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    ) + (if (Build.VERSION.SDK_INT >= 31) setOf(AudioDeviceInfo.TYPE_BLE_HEADSET) else emptySet())

    var speakerOn = false
        private set
    private var active = false

    fun start(context: Context, video: Boolean) {
        val audio = manager(context) ?: return
        active = true
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        setSpeaker(context, video && !headsetConnected(context))
    }

    fun setSpeaker(context: Context, on: Boolean) {
        val audio = manager(context) ?: return
        speakerOn = on
        if (Build.VERSION.SDK_INT >= 31) {
            val devices = audio.availableCommunicationDevices
            val target = if (on) {
                devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            } else {
                devices.firstOrNull { it.type in HEADSETS } ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            }
            if (target != null) audio.setCommunicationDevice(target)
        } else {
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = on
        }
    }

    fun stop(context: Context) {
        if (!active) return
        active = false
        val audio = manager(context) ?: return
        if (Build.VERSION.SDK_INT >= 31) {
            audio.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = false
        }
        audio.mode = AudioManager.MODE_NORMAL
        speakerOn = false
    }

    private fun headsetConnected(context: Context): Boolean =
        manager(context)?.getDevices(AudioManager.GET_DEVICES_OUTPUTS)?.any { it.type in HEADSETS } == true

    private fun manager(context: Context): AudioManager? = context.getSystemService(AudioManager::class.java)
}
