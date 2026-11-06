package com.call9me.app

import android.app.Application

class Call9meApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        Push.fetchToken(this)
    }
}
